#!/usr/bin/env python3
"""Maç sonuçlarını ESPN'den, tahminleri Firestore'dan okuyup puanları hesaplar.

Ürettiği dosyalar (sitenin okuduğu arşiv):
  data/games.json    Sezonun biten maçları: skor, kazanan, fark, en skorer(ler)
  data/players.json  Oyuncuların sezon toplamları (ortalama hesabı için)
  data/scores.json   Her oyuncunun maç maç ve gün gün puanları, toplamlar

Firestore'daki tahminler, ancak maç başladıktan sonra herkese okunur olduğu
için bu betik kimlik bilgisi olmadan çalışır. Sadece Python standart kütüphanesi.

  python scripts/sync.py            # son 3 günü günceller
  python scripts/sync.py --full     # sezon başından baştan kurar
"""
import json
import re
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TR_TZ = ZoneInfo("Europe/Istanbul")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 1.55.0: aynı betik EuroLeague ligi için de çalışır (LEAGUE=el): maçlar EuroLeague'in resmî servisinden, tahminler
# "el_" önekli koleksiyonlardan okunur, sonuçlar data/el/ klasörüne yazılır (app.js ?lg=el ile aynı düzen).
IS_EL = os.environ.get("LEAGUE", "nba") == "el"
DATA = os.path.join(ROOT, "data", "el") if IS_EL else os.path.join(ROOT, "data")
EL_NS = {"picks", "daily", "progress", "league", "talk", "series", "chat", "chatpin", "chatlim", "typing", "dm",
         "polls", "lt", "ltResults", "ft", "reports", "lockExt"}   # app.js EL_NS ile aynı
EL_START = "20261117"   # EuroLeague tahmin liginin ilk gecesi (app.js EL_START)
EL_SEASON_FIRST = "20260924"   # EuroLeague normal sezonunun ilk günü (istatistikler buradan)
CONFIG = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
FS_BASE = "https://firestore.googleapis.com/v1/projects/{p}/databases/(default)/documents"
MARGINS = CONFIG["margins"]


# ---------------------------------------------------------------- yardımcılar
def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "nba-tahmin/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404 or e.code == 403:
                raise
            if i == tries - 1:
                raise
        except Exception:
            if i == tries - 1:
                raise
        time.sleep(1.5 * (i + 1))


def load(name, default):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return default


def save(name, obj):
    os.makedirs(DATA, exist_ok=True)
    p = os.path.join(DATA, name)
    new = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if os.path.exists(p) and open(p, encoding="utf-8").read().strip() == new:
        return False
    with open(p, "w", encoding="utf-8") as f:
        f.write(new + "\n")
    return True


def espn_today() -> date:
    """ESPN'in 'bugün'ü: ABD Doğu saati, gece maçları bitene kadar önceki gün."""
    us_east = datetime.now(timezone.utc) - timedelta(hours=5 + 6)
    return us_east.date()


RULES2_FROM = "20261104"   # 5 barem, günün oyuncusu +3, yanan banko katlanmaz, yeni soru havuzu
MARGINS2 = [(1, 3, "1-3"), (4, 7, "4-7"), (8, 12, "8-12"), (13, 19, "13-19"), (20, 999, "20+")]
MARGINS2_LABELS = {x[2] for x in MARGINS2}
MARGIN_TOL, MARGIN_MAX = 3, (30 if IS_EL else 40)   # app.js MARGIN_MAX ile aynı (EuroLeague 30+)
AUTO_FROM = "20261104"    # yedek tahmin: hiç tahmin yapmayan ve tercihi açık olana ESPN favorileri; her 2 doğru kazanan 1 puan
STREAK_NIGHTS, STREAK_BONUS = (2 if IS_EL else 4), 2   # EuroLeague haftada 2-4 gece (app.js STREAK_N)   # devamlılık: haftada en az 4 gece kendi tahmini olana +2


def margin_bucket2(m):
    for lo, hi, label in MARGINS2:
        if lo <= m <= hi:
            return label
    return MARGINS2[-1][2]


def margin_bucket(m):
    for lo, hi, label in MARGINS:
        if lo <= m <= hi:
            return label
    return MARGINS[-1][2]


def week_key(day: str) -> str:
    d = date(int(day[:4]), int(day[4:6]), int(day[6:]))
    monday = d - timedelta(days=d.weekday())
    return monday.strftime("%Y%m%d")


# ---------------------------------------------------------------- ESPN
def scoreboard(day: str):
    if IS_EL:
        return el_scoreboard(day)
    return get(f"{ESPN}/scoreboard?dates={day}&limit=50").get("events", [])


def made_att(v):
    """'7-15' -> (7, 15)"""
    try:
        a, b = str(v or "0-0").split("-")
        return int(a), int(b)
    except ValueError:
        return 0, 0


def espn_hp(s):
    """ESPN'in maç önü ev sahibi kazanma şansı (0-1): önce maç önü tahmini (sitede gösterilen), yoksa olasılık akışının ilk değeri."""
    try:
        pr = s.get("predictor", {}).get("homeTeam", {}).get("gameProjection")
        if pr not in (None, ""):
            return float(pr) / 100
        wp = s.get("winprobability") or []
        if wp:
            return float(wp[0].get("homeWinPercentage"))
    except (TypeError, ValueError):
        pass
    return None


TIER_FROM, WIN_CAP = "20261104", 4   # sürpriz kademesi; app.js'teki tierOf ile aynı


def auto_points(dgames):
    """Yedek tahmin: ESPN favorisinin kazandığı her 2 maç 1 puan."""
    return sum(1 for g in dgames if g.get("fav") and g["fav"] == g["winner"]) // 2


def streak_bonus(days):
    """Devamlılık bonusu: haftanın 4. kendi tahminli gecesine +2. Her çalışmada baştan hesaplanır (gün satırına "bon")."""
    seen = {}
    for day in sorted(days):
        for uid, v in days[day].items():
            v.pop("bon", None)
            if day < AUTO_FROM or not v.get("n"):
                continue
            k = (v.get("week") or week_key(day), uid)
            seen[k] = seen.get(k, 0) + 1
            if seen[k] == STREAK_NIGHTS:
                v["bon"] = STREAK_BONUS


def tier_of(g, abbr):
    if g.get("day", "") < TIER_FROM or g.get("hp") is None:
        return 1
    p = g["hp"] if abbr == g["home"]["abbr"] else 1 - g["hp"]
    return 3 if p <= 0.20 else 2 if p <= 0.33 else 1


def espn_fav(s):
    """ESPN'in maç önü favorisi: kazanma olasılığı akışının ilk değeri (yoksa maç önü tahmini)."""
    try:
        wp = s.get("winprobability") or []
        if wp:
            h = float(wp[0].get("homeWinPercentage"))
        else:
            h = float(s["predictor"]["homeTeam"]["gameProjection"]) / 100
    except (KeyError, TypeError, ValueError):
        return ""
    comp = s.get("header", {}).get("competitions", [{}])[0].get("competitors", [])
    side = {c.get("homeAway"): c.get("team", {}).get("abbreviation", "") for c in comp}
    return side.get("home", "") if h >= 0.5 else side.get("away", "")


def team_poss(summary):
    """Takım başına hücum sayısı tahmini: isabetsiz dahil atış + 0,44 serbest atış - hücum ribaundu + top kaybı."""
    out = {}
    for t in (summary.get("boxscore", {}) or {}).get("teams", []) or []:
        st = {x.get("name"): x.get("displayValue") for x in t.get("statistics", []) or []}
        try:
            fga = int(str(st.get("fieldGoalsMade-fieldGoalsAttempted", "0-0")).split("-")[1])
            fta = int(str(st.get("freeThrowsMade-freeThrowsAttempted", "0-0")).split("-")[1])
            orb = int(st.get("offensiveRebounds") or 0)
            tov = int(st.get("totalTurnovers") or st.get("turnovers") or 0)
        except (ValueError, IndexError):
            continue
        if fga:
            out[t["team"]["abbreviation"]] = round(fga + 0.44 * fta - orb + tov, 1)
    return out if len(out) == 2 else None

def pm_int(v):
    try:
        return int(str(v or "0").replace("+", ""))
    except ValueError:
        return 0

def box(event_id: str):
    if IS_EL:
        r = el_box(event_id)
        box.last = el_box.last
        return r
    s = get(f"{ESPN}/summary?event={event_id}")
    box.last = s
    players = []
    for team in s.get("boxscore", {}).get("players", []):
        abbr = team["team"]["abbreviation"]
        for st in team.get("statistics", []):
            keys = st.get("keys", [])
            for a in st.get("athletes", []):
                if a.get("didNotPlay") or not a.get("stats"):
                    continue
                row = dict(zip(keys, a["stats"]))
                try:
                    pts = int(row.get("points", 0) or 0)
                except ValueError:
                    pts = 0
                def num(k):
                    try:
                        return int(row.get(k, 0) or 0)
                    except ValueError:
                        return 0
                players.append({
                    "id": a["athlete"]["id"], "name": a["athlete"]["displayName"], "team": abbr,
                    "pts": pts, "reb": num("rebounds"), "ast": num("assists"),
                    "stl": num("steals"), "blk": num("blocks"),
                    "fg": made_att(row.get("fieldGoalsMade-fieldGoalsAttempted")),
                    "tp": made_att(row.get("threePointFieldGoalsMade-threePointFieldGoalsAttempted")),
                    "min": row.get("minutes", "0"),
                    # 1.57.1: savunma kategorileri için savunma ribaundu, +/- ve faul
                    "dreb": num("defensiveRebounds"), "pf": num("fouls"),
                    "pm": pm_int(row.get("plusMinus")),
                })
    return players


def finished_game(ev):
    c = ev["competitions"][0]
    if c["status"]["type"].get("state") != "post":
        return None
    side = {}
    for t in c["competitors"]:
        side[t["homeAway"]] = {
            "abbr": t["team"]["abbreviation"], "id": t["team"]["id"],
            "score": int(t.get("score") or 0), "winner": bool(t.get("winner")),
        }
    h, a = side["home"], side["away"]
    winner = h["abbr"] if h["score"] > a["score"] else a["abbr"]
    g = {
        "id": ev["id"], "start": ev["date"], "seasonType": ev.get("season", {}).get("type", 2),
        "home": h, "away": a, "winner": winner,
        "margin": abs(h["score"] - a["score"]),
        "bucket": margin_bucket(abs(h["score"] - a["score"])),
        "ot": int(c["status"].get("period") or 4) > 4,
    }
    note = next((n.get("headline", "") for n in c.get("notes", []) if "NBA Cup" in n.get("headline", "")), "")
    g["cup"] = bool(note)
    if note:
        g["cupStage"] = note.split("-", 1)[-1].strip() if "-" in note else "Group Play"
    sr = series_info(ev)
    if sr:
        g["series"] = sr
    return g


def series_info(ev):
    """Playoff serisi: anahtar (sezon + iki takım), kazanılan maçlar, bitti mi."""
    c = ev["competitions"][0]
    s = c.get("series")
    if not s or ev.get("season", {}).get("type") != 3:
        return None
    by_id = {t["team"]["id"]: t["team"]["abbreviation"] for t in c["competitors"]}
    wins = {by_id.get(str(x.get("id")), str(x.get("id"))): int(x.get("wins") or 0) for x in s.get("competitors", [])}
    abbrs = sorted(by_id.values())
    return {"key": f"{ev.get('season', {}).get('year', '')}{'-'.join(abbrs)}", "wins": wins,
            "done": bool(s.get("completed")), "need": (int(s.get("totalCompetitions") or 7) // 2) + 1}


# ---------------------------------------------------------------- EuroLeague (LEAGUE=el)
ELAPI = "https://api-live.euroleague.net/v2/competitions/E/seasons"


def el_season():
    d = datetime.now(timezone.utc)
    return f"E{d.year if d.month >= 8 else d.year - 1}"


def el_gid(g):
    return f"{el_season()[1:]}{int(g['gameCode']):03d}"


def el_pid(v):
    return re.sub(r"\D", "", str(v or "")).lstrip("0") or "0"


def el_name(n):
    """'SARIC, DARIO' -> 'Dario Saric' (app.js elName ile aynı)."""
    def cap(x):
        x = x.replace("İ", "i").lower()
        return re.sub(r"(^|[\s'.-])(\w)", lambda m: m.group(1) + m.group(2).upper(), x)
    parts = [x.strip() for x in str(n or "").split(",")]
    return f"{cap(parts[1])} {cap(parts[0])}" if len(parts) > 1 and parts[1] else cap(parts[0])


def el_et_day(utc):
    return (datetime.fromisoformat(utc.replace("Z", "+00:00")) - timedelta(hours=5)).strftime("%Y%m%d")


def el_all_games():
    if not hasattr(el_all_games, "c"):
        el_all_games.c = get(f"{ELAPI}/{el_season()}/games").get("data", [])
    return el_all_games.c


def el_standings(n):
    """Turun sonundaki puan durumu {kulüp: veri} (app.js elStandAt)."""
    if n < 1:
        return None
    el_standings.c = getattr(el_standings, "c", {})
    if n not in el_standings.c:
        try:
            r = get(f"{ELAPI}/{el_season()}/rounds/{n}/standings")
            el_standings.c[n] = {x["club"]["code"]: x.get("data") or {} for x in (r[0].get("standings") or [])} if r else {}
        except Exception as e:   # noqa: BLE001
            print("Puan durumu alınamadı", n, e, file=sys.stderr)
            el_standings.c[n] = {}
    return el_standings.c[n] or None


def el_home_prob(g):
    """app.js elHomeProb ile aynı model: maç başına sayı farkı (az maçta sıfıra çekilir) + 3 sayı saha avantajı, lojistik."""
    import math
    st = el_standings((g.get("round") or 1) - 1)
    if not st:
        return None
    def net(c):
        d = st.get(c) or {}
        gp = d.get("gamesPlayed") or 0
        return 0 if not gp else (d["pointsFavour"] - d["pointsAgainst"]) / gp * gp / (gp + 4)
    mg = net(g["local"]["club"]["code"]) - net(g["road"]["club"]["code"]) + 3
    return 1 / (1 + math.exp(-mg / 7))


def el_event(g):
    st = "post" if g.get("played") else "pre"
    def side(t, o, h):
        return {"homeAway": h, "team": {"abbreviation": t["club"]["code"], "id": t["club"]["code"]},
                "score": t.get("score") or 0, "winner": st == "post" and (t.get("score") or 0) > (o.get("score") or 0)}
    ot = bool((g["local"].get("partials") or {}).get("extraPeriods"))
    return {"id": el_gid(g), "date": g["utcDate"], "season": {"type": 2}, "el": g,
            "competitions": [{"status": {"period": 5 if ot else 4, "type": {"state": st}}, "notes": [],
                              "competitors": [side(g["local"], g["road"], "home"), side(g["road"], g["local"], "away")]}]}


def el_save_all_players():
    """EuroLeague kulüpleri ve oyuncuları -> data/el/allplayers.json (NBA'deki allplayers.json ile aynı biçim)."""
    clubs = [c for c in get(f"{ELAPI}/{el_season()}/clubs").get("data", []) if not c.get("isVirtual")]
    out, tl = [], []
    for c in clubs:
        tl.append({"a": c["code"], "n": c.get("editorialName") or c.get("name", ""), "id": c["code"]})
        r = get(f"{ELAPI}/{el_season()}/clubs/{c['code']}/people")
        for x in (r.get("data", r) if isinstance(r, dict) else r) or []:
            if x.get("type") == "J" and x.get("active") is not False and (x.get("person") or {}).get("code"):
                y = {"id": el_pid(x["person"]["code"]), "n": el_name(x["person"].get("name")), "t": c["code"]}
                img = (x.get("images") or {}).get("headshot") or (x.get("person", {}).get("images") or {}).get("headshot")
                if img:
                    y["img"] = img
                if x.get("positionName"):
                    y["pos"] = x["positionName"]
                out.append(y)
    if len(out) < 150:
        raise RuntimeError(f"yalnızca {len(out)} oyuncu geldi")
    seen = {x["id"] for x in out}
    out += [x for x in load("allplayers.json", {}).get("players", []) if x["id"] not in seen]
    out.sort(key=lambda x: (x["n"], x["id"]))
    tl.sort(key=lambda x: x["n"])
    return save("allplayers.json", {"teams": tl, "players": out})


def el_scoreboard(day):
    return [el_event(g) for g in el_all_games() if el_et_day(g["utcDate"]) == day]


def el_box(event_id):
    code = int(str(event_id)[4:])
    g = next(x for x in el_all_games() if int(x["gameCode"]) == code)
    bx = get(f"https://live.euroleague.net/api/Boxscore?gamecode={code}&seasoncode={el_season()}")
    hp = el_home_prob(g)
    comp = el_event(g)["competitions"][0]
    el_box.last = {"round": g.get("round"), "header": {"competitions": [{"status": {"type": {"completed": bool(g.get("played")) and bx.get("Live") is False}},
                                                "competitors": comp["competitors"]}]},
                   **({"predictor": {"homeTeam": {"gameProjection": round(hp * 100, 1)}}} if hp is not None else {})}
    clubs = [g["local"]["club"]["code"], g["road"]["club"]["code"]]
    players = []
    for i, T in enumerate(bx.get("Stats") or []):
        for p in T.get("PlayersStats") or []:
            if not p.get("Minutes") and not p.get("Points"):
                continue
            fgm = (p.get("FieldGoalsMade2") or 0) + (p.get("FieldGoalsMade3") or 0)
            fga = (p.get("FieldGoalsAttempted2") or 0) + (p.get("FieldGoalsAttempted3") or 0)
            players.append({"id": el_pid(p.get("Player_ID")), "name": el_name(p.get("Player")), "team": clubs[i] if i < 2 else "",
                            "pts": p.get("Points") or 0, "reb": p.get("TotalRebounds") or 0, "ast": p.get("Assistances") or 0,
                            "stl": p.get("Steals") or 0, "blk": p.get("BlocksFavour") or 0,
                            "fg": (fgm, fga), "tp": (p.get("FieldGoalsMade3") or 0, p.get("FieldGoalsAttempted3") or 0),
                            "min": str(p.get("Minutes") or "0").split(":")[0], "val": p.get("Valuation") or 0})
    return players


# ---------------------------------------------------------------- Firestore
def fs_value(v):
    if "stringValue" in v: return v["stringValue"]
    if "integerValue" in v: return int(v["integerValue"])
    if "doubleValue" in v: return v["doubleValue"]
    if "booleanValue" in v: return v["booleanValue"]
    if "timestampValue" in v: return v["timestampValue"]
    if "nullValue" in v: return None
    if "mapValue" in v: return {k: fs_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v: return [fs_value(x) for x in v["arrayValue"].get("values", [])]
    return None


EMU = os.environ.get("FIRESTORE_EMULATOR_HOST")  # test için


def fs_url(path):
    if IS_EL:
        head, _, rest = path.partition("/")
        name, q, qs = head.partition("?")
        if name in EL_NS:
            path = "el_" + name + q + qs + ("/" + rest if rest else "")
    fb = CONFIG["firebase"]
    if EMU:
        return f"http://{EMU}/v1/projects/demo-tahmin/databases/(default)/documents/{path}"
    if fb["projectId"] == "BURAYA":
        return None
    sep = "&" if "?" in path else "?"
    return FS_BASE.format(p=fb["projectId"]) + "/" + path + sep + "key=" + fb["apiKey"]


def fs_doc(path):
    url = fs_url(path)
    if not url:
        return None
    try:
        d = get(url, tries=2)
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise
    return {k: fs_value(v) for k, v in d.get("fields", {}).items()}


# Uzun vade: kategori -> puan (app.js'teki LT_CATS ile aynı)
LT_PTS = {"w": {"e": 2, "w": 2},
          "m": {"pe": 4, "pw": 4, "re": 3, "rw": 3, "de": 3, "dw": 3},
          "c": {"cw": 8, "cfe": 3, "cfw": 3, "cmvp": 6},
          "k": {f"{c}{i}": 2 for c in "ew" for i in range(1, 7)},
          "s": {"mvp": 12, "roy": 8, "dpoy": 8, "mip": 8, "smoy": 8, "coy": 8, "champ": 10, "fe": 5, "fw": 5}}


def fs_list(coll):
    url = fs_url(f"{coll}?pageSize=300")
    if not url:
        return {}
    try:
        d = get(url, tries=3)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise   # geçici hata: boş liste sayılmasın (uzun vade puanları silinmiş gibi görünürdü)
    return {x["name"].rsplit("/", 1)[1]: {k: fs_value(v) for k, v in x.get("fields", {}).items()} for x in d.get("documents", [])}


def lt_lock(k):
    """Uzun vade turunun kilit anı (app.js ltLock ile aynı)."""
    if k[0] == "w":
        return datetime(int(k[2:6]), int(k[6:8]), int(k[8:10]), tzinfo=timezone.utc) + timedelta(hours=71)
    if k[0] == "m":
        return datetime(int(k[2:6]), int(k[6:8]), 15, 17, tzinfo=timezone.utc)
    if k[0] == "c":
        return datetime(2026, 12, 4, 17, tzinfo=timezone.utc)
    if k[0] == "k":
        return datetime(2026, 12, 1, 17, tzinfo=timezone.utc)
    return datetime(2027, 1, 15, 17, tzinfo=timezone.utc)


# EuroLeague uzun vadesi (1.56.0): resmî ödüllerle aynı iki seçim (app.js EL_MVP_*)
#  - Turun MVP'si  r_<turun ilk maç günü>_<tur>: o turda kazanan takımdan en yüksek PIR'i alan oyuncu (EuroLeague'in kuralı;
#    eşitlikte ödül paylaşılır). Kutu skorlarından otomatik hesaplanır. Bilene +3.
#  - Ayın MVP'si   m_<yyyymm>: EuroLeague'in açıkladığı oyuncu; yönetici el_ltResults/m_<yyyymm> {mvp:[id]} olarak girer. Bilene +5.
EL_MVP_PTS = {"r": 3, "m": 5}


def el_round_keys():
    """{tur: (anahtar, bütün maçları bitti mi)} — anahtar turun ilk maçının gününden."""
    rounds = {}
    for g in el_all_games():
        rounds.setdefault(g["round"], []).append(g)
    out = {}
    for n, G in rounds.items():
        first = min(G, key=lambda x: x["utcDate"])["utcDate"][:10].replace("-", "")
        out[n] = (f"r_{first}_{n}", all(x.get("played") for x in G))
    return out


def el_round_mvp(games, n):
    """Turun MVP'si: kazanan takımlardan en yüksek PIR. {"mvp": [id...], "pir": değer} ya da None."""
    best, win = None, []
    for g in games.values():
        if g.get("round") != n or not g.get("pir"):
            continue
        for pid, (v, w) in g["pir"].items():
            if not w:
                continue
            if best is None or v > best:
                best, win = v, [pid]
            elif v == best:
                win.append(pid)
    return {"mvp": sorted(win), "pir": best} if win else None


def el_lt_scores(players, games, league_start):
    """EuroLeague uzun vadesi puanları: {uid: {anahtar: puan}}, anahtarların günü ve sonuçlar."""
    out, days, res = {}, {}, {}
    for n, (k, done) in sorted(el_round_keys().items()):
        if not done or k[2:10] < league_start:
            continue
        r = el_round_mvp(games, n)
        if not r:
            continue
        res[k] = r
        days[k] = max((g["day"] for g in games.values() if g.get("round") == n), default=k[2:10])
    for k, r in (fs_list("ltResults") or {}).items():   # ayın MVP'si (yönetici girer)
        if re.match(r"^m_\d{6}$", k) and r.get("mvp") and f"{k[2:]}01" >= league_start[:6] + "01":
            res[k] = {"mvp": list(r["mvp"]), "names": r.get("names") or {}}
            days[k] = max((g["day"] for g in games.values() if g.get("day", "")[:6] == k[2:]), default=f"{k[2:]}28")
    for k, r in res.items():
        for uid in players:
            d = fs_doc(f"lt/{k}_{uid}") or {}
            pick = (d.get("picks") or {}).get("mvp")
            if pick:
                out.setdefault(uid, {})[k] = EL_MVP_PTS[k[0]] if pick in r["mvp"] else 0
    return out, days, res


def lt_scores(players, league_start="00000000"):
    """Sonuçlanan uzun vade turlarının puanları: {uid: {tur: puan}} ve her turun gün anahtarı.
    Yalnızca lig başladıktan sonra (başlangıç gecesi 12.00 UTC) kilitlenen turlar sayılır."""
    out, days = {}, {}
    ls = datetime(int(league_start[:4]), int(league_start[4:6]), int(league_start[6:8]), 12, tzinfo=timezone.utc) if league_start[:4] != "0000" else None
    for k, r in fs_list("ltResults").items():
        try:
            if ls and lt_lock(k) < ls:
                continue
        except (ValueError, IndexError):
            pass
        cats = LT_PTS.get(k[:1], {})
        if not any(r.get(c) for c in cats):
            continue
        at = r.get("at")
        days[k] = (ts(at) - timedelta(hours=8)).astimezone(TR_TZ).strftime("%Y%m%d") if at else None
        for uid in players:
            d = fs_doc(f"lt/{k}_{uid}") or {}
            picks, swaps = dict(d.get("picks") or {}), d.get("swaps") or {}
            pts = 0
            for c, p in cats.items():
                sw = swaps.get(c) or {}
                mine = sw.get("to") or picks.get(c)
                if not (r.get(c) and mine):
                    continue
                if k[0] == "k":   # konferans sıralaması: tam yer +2, bir sıra şaşma +1
                    slot = next((x for x in r if re.fullmatch(r"[ew]\d+", x) and x[0] == c[0] and str(r[x]) == str(mine)), None)
                    if slot:
                        d = abs(int(slot[1:]) - int(c[1:]))
                        pts += p if d == 0 else 1 if d == 1 else 0
                elif str(mine) == str(r[c]):
                    pts += p // 2 if sw else p
            if pts:
                out.setdefault(uid, {})[k] = pts
    return out, days


AY = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]


def award_month(day):
    return "202611" if day < "20261201" else day[:6]


WEEK_AWARD_FROM = "20261109"            # haftalık ilk 3 ödülü asıl ligle başlar
WEEK_PRIZE = {1: 5, 2: 3, 3: 1}


def week_awards(sc, games, players, nights, cur_week):
    """Biten her haftanın ilk 3'üne ek puan (5 / 3 / 1).
    Sıralama yalnızca o haftanın gece puanlarıyla (devamlılık bonusu, playoff serisi, aylık ödül ve uzun vade hariç).
    Eşitlikte sırayla: haftadaki gece birincilikleri, kazanan puanı, fark, en skorer, haftanın en iyi gecesi.
    Bunlar da eşitse sıra paylaşılır (ikisi de o sıranın puanını alır); sıra atlanmaz, ardından gelen bir sonraki sıranın puanını alır."""
    out = {}
    by_wk = {}
    for d in sc["days"]:
        if d >= WEEK_AWARD_FROM:
            by_wk.setdefault(week_key(d), []).append(d)
    for wk, days in sorted(by_wk.items()):
        if wk >= cur_week or not all(nights.get(d, {}).get("done") for d in days):
            continue
        st = {}
        for d in sorted(days):
            row = sc["days"][d]
            pts = {u: v.get("pts", 0) for u, v in row.items() if u in players}
            if not pts:
                continue
            best = max(pts.values())
            top = [u for u, v in pts.items() if v == best]
            for u, v in pts.items():
                x = st.setdefault(u, {"p": 0, "nw": 0, "w": 0, "m": 0, "s": 0, "bn": 0})
                x["p"] += v
                x["bn"] = max(x["bn"], v)
                if len(top) == 1 and top[0] == u and any(r.get("n") for r in row.values()):
                    x["nw"] += 1
        dayset = set(days)
        for gid, row in sc["games"].items():
            if games.get(gid, {}).get("day") not in dayset:
                continue
            for u, r in row.items():
                if u in st and r.get("pick"):
                    st[u]["w"] += r.get("w", 0)
                    st[u]["m"] += r.get("m", 0)
                    st[u]["s"] += r.get("s", 0)
        key = lambda u: (st[u]["p"], st[u]["nw"], st[u]["w"], st[u]["m"], st[u]["s"], st[u]["bn"])
        order = sorted((u for u in st if st[u]["p"] > 0), key=key, reverse=True)
        lst, place = [], 0
        for i, u in enumerate(order):
            if i == 0 or key(u) != key(order[i - 1]):
                place += 1   # sıra atlanmaz: iki birinciden sonraki ikinci olur
            if place > 3:
                break
            lst.append({"u": u, "place": place, "pts": WEEK_PRIZE[place], "wp": st[u]["p"]})
        if lst:
            out[wk] = lst
    return out


def league_awards(sc, games, players, today, league_start):
    """Biten her ay için 5 ödül. Eşitlikte ödül paylaşılır (hepsi puanı alır). Kimse şartı sağlamazsa ödül boş kalır."""
    out = {}
    months = sorted({award_month(d) for d in sc["days"] if d >= (league_start or "")})
    for mk in months:
        y, m = int(mk[:4]), int(mk[4:])
        end = f"{y + (m == 12)}{(m % 12) + 1:02d}01"
        if today < end:
            continue  # ay bitmedi
        days = [d for d in sc["days"] if award_month(d) == mk and d >= (league_start or "")]
        if not days:
            continue
        st = {u: {"pts": 0, "bn": 0, "bok": 0, "sur": 0, "sc": 0, "mg": 0} for u in players}
        for d in days:
            for u, v in sc["days"][d].items():
                if u in st:
                    st[u]["pts"] += v.get("tot", v.get("pts", 0))
        for gid, row in sc["games"].items():
            g = games.get(gid)
            if not g or award_month(g.get("day", "")) != mk or g.get("day", "") < (league_start or ""):
                continue
            for u, r in row.items():
                if u not in st or not r.get("pick"):
                    continue
                if r.get("c"):
                    st[u]["bn"] += 1
                    st[u]["bok"] += r.get("w", 0) > 0
                if g.get("fav") and r["pick"].get("w") and r["pick"]["w"] != g["fav"] and r.get("w", 0) > 0:
                    st[u]["sur"] += 1
                st[u]["sc"] += r.get("s", 0) > 0
                st[u]["mg"] += r.get("m", 0)   # nokta atışı 2 sayılır

        def best(key, minv=1, cond=lambda x: True):
            vals = {u: key(x) for u, x in st.items() if cond(x)}
            if not vals:
                return [], 0
            top = max(vals.values())
            return ([u for u, v in vals.items() if v == top], top) if top >= minv else ([], top)

        lst = []
        w, v = best(lambda x: x["pts"])
        lst.append({"k": "top", "i": "👑", "t": "Ayın tahmincisi", "d": "Ayın en çok puan toplayanı", "u": w, "v": f"{v} puan", "pts": 1})
        w, v = best(lambda x: round(x["bok"] / x["bn"] * 100), 1, lambda x: x["bn"] >= 4)
        lst.append({"k": "banko", "i": "★", "t": "Banko ustası", "d": "En yüksek banko isabeti (en az 4 banko)", "u": w, "v": f"%{v}", "pts": 2})
        w, v = best(lambda x: x["sur"])
        lst.append({"k": "surpriz", "i": "🎯", "t": "Sürpriz avcısı", "d": "ESPN'in favorisinin karşısına geçip en çok bilen", "u": w, "v": f"{v} maç", "pts": 2})
        w, v = best(lambda x: x["sc"])
        lst.append({"k": "skorer", "i": "🔥", "t": "Skorer ustası", "d": "En skoreri en çok bilen", "u": w, "v": f"{v} maç", "pts": 2})
        w, v = best(lambda x: x["mg"])
        lst.append({"k": "fark", "i": "📏", "t": "Fark ustası", "d": "Farkı en çok tutturan (nokta atışı 2 sayılır)", "u": w, "v": f"{v} puan", "pts": 2})
        title = f"{AY[m - 1]} ödülleri"   # lig Kasım'da başladığı için Ekim'in son günleri Kasım'a sayılır
        out[mk] = {"title": title, "list": lst}
    return out


def backup(players, today):
    """Haftalık yedek: data/backup/<pazartesi>.json. Herkese açık okunabilen veriler (oyuncular, lig ayarları,
    uzun vade sonuçları ve kilitlenmiş uzun vade seçimleri). Gece gece tahminler zaten scores.json'da (git geçmişinde) duruyor."""
    wk = week_key(today.strftime("%Y%m%d"))
    # Güvenlik (1.30.2): depo herkese açık, o yüzden yedek şifreli yazılır (openssl cms, scripts/backup-cert.pem ile).
    # Açmak için özel anahtar gerekir (yalnızca yöneticide, GitHub'da yok):
    #   openssl cms -decrypt -inform DER -in data/backup/<gün>.json.cms -inkey yedek-ozel-anahtar.pem -out yedek.json
    path = os.path.join(DATA, "backup", f"{wk}.json.cms")
    cert = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backup-cert.pem")
    if os.path.exists(path) or not os.path.exists(cert):
        return False
    res = fs_list("ltResults")
    lt = {}
    for k in res:
        for uid in players:
            d = fs_doc(f"lt/{k}_{uid}")
            if d:
                lt[f"{k}_{uid}"] = d
    data = {"at": datetime.now(timezone.utc).isoformat(), "players": fs_list("players"), "league": fs_list("league"),
            "ltResults": res, "lt": lt}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    import subprocess
    raw = json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True).encode("utf-8")
    r = subprocess.run(["openssl", "cms", "-encrypt", "-aes256", "-binary", "-outform", "DER", "-out", path, cert],
                       input=raw, capture_output=True)
    if r.returncode != 0:
        print("yedek şifrelenemedi, yazılmadı:", r.stderr.decode()[-200:])
        if os.path.exists(path):
            os.remove(path)
        return False
    return True


def fs_players():
    """Oyuncu listesi. Firestore'a ulaşılamazsa HATA verir: boş liste dönerse bütün puanlar silinmiş gibi yazılırdı."""
    url = fs_url("players?pageSize=300")
    if not url:
        return {}
    d = get(url, tries=4)
    out = {}
    for doc in d.get("documents", []):
        uid = doc["name"].rsplit("/", 1)[1]
        f = {k: fs_value(v) for k, v in doc.get("fields", {}).items()}
        out[uid] = {"name": f.get("name", "?"), "joined": f.get("joined"), "autoPick": bool(f.get("autoPick"))}
    if IS_EL:
        elp = fs_list("elPlayers")
        out = {u: {**v, "joined": elp[u].get("joined") or v["joined"]} for u, v in out.items() if u in elp}
    return out


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------- puanlama
def score_game(g, pick, conf, top_ids):
    """Bir oyuncunun bir maçtan aldığı puan ve ayrıntısı."""
    # playoff ve (4 Kasım 2026'dan itibaren) NBA Kupası maçları 2 kat
    mult = 2 if g["seasonType"] == 3 or (g.get("cup") and g.get("day", "") >= CUP2X_FROM) else 1
    r = {"w": 0, "m": 0, "s": 0, "c": bool(conf), "pts": 0, "pick": None}
    if not pick:
        return r
    r["pick"] = {"w": pick.get("winner"), "m": pick.get("margin"), "s": pick.get("scorerName")}
    won = pick.get("winner") == g["winner"]
    r["tier"] = tier_of(g, pick.get("winner"))
    if won:
        r["w"] = (2 if conf else 1) * r["tier"]
        lab = str(pick.get("margin") or "")
        if lab.isdigit():   # 1.13.0: sayıyla fark, gerçek farka 3 sayı ya da daha yakın (40 = 40 ve üstü)
            hit = g["margin"] >= MARGIN_MAX - MARGIN_TOL if int(lab) >= MARGIN_MAX else abs(int(lab) - g["margin"]) <= MARGIN_TOL
        else:
            hit = (margin_bucket2(g["margin"]) == lab) if lab in MARGINS2_LABELS else (lab == g["bucket"])
        if hit:
            # 1.23.0: asıl ligden itibaren farkı tam bilen +1 ek (fark puanı 2); "40+" tam sayılmaz
            exact = g.get("day", "") >= EXACT_FROM and lab.isdigit() and int(lab) < MARGIN_MAX and int(lab) == g["margin"]
            r["m"] = 2 if exact else 1
    elif conf:
        r["w"] = -1
    if pick.get("scorerId") in top_ids:
        r["s"] = 1
    r["pts"] = min(WIN_CAP, max(r["w"], 0) * mult) + (r["m"] + r["s"]) * mult + min(r["w"], 0)   # kazanan en fazla 4; yanan banko katlanmaz
    return r


LOCK = timedelta(0)  # 3 Kasım 2026 öncesi: gecenin bütün tahminleri ilk maç başlayınca kilitlenir
GAP_FROM, PERGAME_FROM = "20261103", "20261104"
EXACT_FROM = "20261109"   # tam fark (nokta atışı) ödülü asıl ligle başlar
CUP2X_FROM = "20261104"   # 3 Kasım: kilit 10 dk önce; 4 Kasım: her maç kendi saatinde


def lock_gap(day):
    return timedelta(minutes=10) if day >= GAP_FROM else LOCK

# Gecenin sorusu: gün numarasına göre sırayla seçilir. app.js'teki QUESTIONS ile birebir aynı sıra.
QUESTIONS = [
    lambda gs: max(max((t["pts"] for t in g["top"]), default=0) for g in gs) >= 40,   # en skorer 40+
    lambda gs: max(g["margin"] for g in gs) >= 20,                                    # 20+ farklı maç
    lambda gs: any(g.get("ot") for g in gs),                                          # uzatma
    lambda gs: max(max(g["home"]["score"], g["away"]["score"]) for g in gs) >= 130,   # 130+ atan takım
    lambda gs: sum(g["winner"] == g["away"]["abbr"] for g in gs) > sum(g["winner"] == g["home"]["abbr"] for g in gs),
    lambda gs: min(g["margin"] for g in gs) <= 3,                                     # 3 ve daha az farklı maç
]


def top(gs):
    return max(max((t["pts"] for t in g["top"]), default=0) for g in gs)


# 4 Kasım 2026'dan itibaren: app.js'teki QUESTIONS2 ile birebir aynı sıra (1970'ten beri geçen gün % soru sayısı)
QUESTIONS2 = [
    lambda gs: top(gs) >= 33,  # Bu gece biri 33 ya da daha fazla sayı atar mı?
    lambda gs: max(g['margin'] for g in gs) >= 25,  # Bu gece en az bir maç 25 sayı ya da daha fazla farkla biter mi?
    lambda gs: any(g.get('ot') for g in gs),  # Bu gece en az bir maç uzatmaya gider mi?
    lambda gs: min(min(g['home']['score'], g['away']['score']) for g in gs) <= 95,  # Bu gece bir takım 95 ya da daha az sayıda kalır mı?
    lambda gs: top(gs) >= 45,  # Bu gece biri 45 ya da daha fazla sayı atar mı?
    lambda gs: min(g['margin'] for g in gs) <= 2,  # Bu gece en az bir maç 2 sayı ya da daha az farkla biter mi?
    lambda gs: max(max(g['home']['score'], g['away']['score']) for g in gs) >= 135,  # Bu gece bir takım 135 ya da daha fazla sayı atar mı?
    lambda gs: sum(g['winner'] == g['away']['abbr'] for g in gs) > sum(g['winner'] == g['home']['abbr'] for g in gs),  # Deplasman takımları bu gece ev sahiplerinden daha çok maç kazanır mı?
    lambda gs: top(gs) >= 38,  # Bu gece biri 38 ya da daha fazla sayı atar mı?
    lambda gs: max(g['home']['score'] + g['away']['score'] for g in gs) >= 250,  # Bu gece bir maçta iki takımın toplamı 250 sayıyı geçer mi?
    lambda gs: sum(g['margin'] >= 15 for g in gs) >= 2,  # Bu gece en az iki maç 15 sayı ya da daha fazla farkla biter mi?
    lambda gs: sum(bool(g.get('ot')) for g in gs) >= 2,  # Bu gece en az iki maç uzatmaya gider mi?
    lambda gs: top(gs) >= 50,  # Bu gece biri 50 ya da daha fazla sayı atar mı?
    lambda gs: all(g['winner'] == g['home']['abbr'] for g in gs),  # Ev sahipleri bu gece bütün maçlarını kazanır mı?
    lambda gs: max(g['margin'] for g in gs) >= 30,  # Bu gece en az bir maç 30 sayı ya da daha fazla farkla biter mi?
    lambda gs: max(max(g['home']['score'], g['away']['score']) for g in gs) >= 130,  # Bu gece bir takım 130 ya da daha fazla sayı atar mı?
    lambda gs: min(g['margin'] for g in gs) <= 5,  # Bu gece en az bir maç 5 sayı ya da daha az farkla biter mi?
    lambda gs: top(gs) >= 40,  # Gecenin en skoreri 40 ya da daha fazla sayı atar mı?
    lambda gs: min(g['home']['score'] + g['away']['score'] for g in gs) < 205,  # Bu gece bir maçta iki takımın toplamı 205 sayının altında kalır mı?
    lambda gs: sum(g['winner'] == g['home']['abbr'] for g in gs) > sum(g['winner'] == g['away']['abbr'] for g in gs),  # Ev sahipleri bu gece deplasman takımlarından daha çok maç kazanır mı?
    lambda gs: max(max(g['home']['score'], g['away']['score']) for g in gs) >= 140,  # Bu gece bir takım 140 ya da daha fazla sayı atar mı?
]


# 5 Kasım 2026'dan itibaren: eşik gecenin maç sayısına göre (app.js'teki QUESTIONS3 / q3Param ile birebir aynı)
Q3_FROM = "20261105"


def _qpw(x, i):
    r = 1.0
    for _ in range(i):
        r *= x
    return r


def _q_any(q, n):
    return 1 - _qpw(1 - q, n)


def _q_at_least(p, n, k):
    s = 0.0
    for i in range(k, n + 1):
        c = 1.0
        for j in range(i):
            c = c * (n - j) / (j + 1)
        s += c * _qpw(p, i) * _qpw(1 - p, n - i)
    return s


def _gtop(g):
    return max((t["pts"] for t in g["top"]), default=0)


def _hi(g):
    return max(g["home"]["score"], g["away"]["score"])


def _lo(g):
    return min(g["home"]["score"], g["away"]["score"])


def _tot(g):
    return g["home"]["score"] + g["away"]["score"]


QUESTIONS3 = [
    ("x", [(30, .505), (32, .421), (34, .355), (36, .252), (38, .196), (40, .14), (42, .103), (44, .056), (46, .03), (50, .012)], lambda g, x: _gtop(g) >= x),
    ("k", .514, lambda g: g["winner"] == g["home"]["abbr"]),
    ("x", [(10, .542), (15, .355), (20, .252), (25, .131), (30, .075), (35, .04), (40, .025)], lambda g, x: g["margin"] >= x),
    ("k", .449, lambda g: _tot(g) >= 230),
    ("x", [(10, .495), (8, .421), (7, .346), (6, .252), (5, .206), (4, .131), (3, .075), (2, .04), (1, .028)], lambda g, x: g["margin"] <= x),
    ("k", .505, lambda g: _gtop(g) >= 30),
    ("x", [(115, .682), (120, .561), (125, .374), (130, .196), (135, .084), (140, .025), (145, .01)], lambda g, x: _hi(g) >= x),
    ("k", .542, lambda g: g["margin"] >= 10),
    ("x", [(110, .598), (105, .477), (100, .308), (95, .187), (90, .084), (85, .04)], lambda g, x: _lo(g) <= x),
    ("k", .561, lambda g: _hi(g) >= 120),
    ("x", [(220, .636), (230, .449), (240, .262), (250, .121), (260, .05), (270, .02)], lambda g, x: _tot(g) >= x),
    ("k", .346, lambda g: g["margin"] <= 7),
    ("k", .486, lambda g: g["winner"] == g["away"]["abbr"]),
    ("x", [(230, .55), (225, .439), (220, .393), (215, .318), (210, .206), (205, .131), (200, .093), (195, .075)], lambda g, x: _tot(g) <= x),
    ("k", .308, lambda g: _lo(g) <= 100),
    ("k", .28, lambda g: _gtop(g) >= 35),
    ("k", .355, lambda g: g["margin"] >= 15),
    ("k", .374, lambda g: _hi(g) >= 125),
    ("k", .43, lambda g: _lo(g) >= 110),
    ("k", .262, lambda g: _tot(g) >= 240),
    ("k", .318, lambda g: _tot(g) <= 215),
]

# EuroLeague (1.55.0): aynı 21 soru, eşikler ve oranlar EuroLeague 2026-27'nin ilk 110 maçından (app.js QUESTIONS3_EL ile aynı)
QUESTIONS3_EL = [
    ("x", [(20, .636), (22, .427), (24, .30), (26, .182), (28, .082), (30, .064), (32, .036), (35, .009)], lambda g, x: _gtop(g) >= x),
    ("k", .536, lambda g: g["winner"] == g["home"]["abbr"]),
    ("x", [(10, .473), (15, .309), (20, .109), (25, .027), (30, .018)], lambda g, x: g["margin"] >= x),
    ("k", .473, lambda g: _tot(g) >= 175),
    ("x", [(10, .591), (8, .482), (7, .418), (6, .355), (5, .318), (4, .255), (3, .191), (2, .127), (1, .018)], lambda g, x: g["margin"] <= x),
    ("k", .427, lambda g: _gtop(g) >= 22),
    ("x", [(90, .6), (95, .409), (100, .255), (105, .118), (110, .055), (115, .018)], lambda g, x: _hi(g) >= x),
    ("k", .473, lambda g: g["margin"] >= 10),
    ("x", [(85, .655), (80, .464), (75, .264), (70, .136), (65, .055)], lambda g, x: _lo(g) <= x),
    ("k", .409, lambda g: _hi(g) >= 95),
    ("x", [(165, .691), (170, .6), (175, .473), (180, .373), (185, .30), (190, .255), (200, .082)], lambda g, x: _tot(g) >= x),
    ("k", .418, lambda g: g["margin"] <= 7),
    ("k", .464, lambda g: g["winner"] == g["away"]["abbr"]),
    ("x", [(180, .636), (175, .536), (170, .427), (165, .318), (160, .236), (155, .182), (150, .109), (145, .055)], lambda g, x: _tot(g) <= x),
    ("k", .264, lambda g: _lo(g) <= 75),
    ("k", .30, lambda g: _gtop(g) >= 24),
    ("k", .309, lambda g: g["margin"] >= 15),
    ("k", .255, lambda g: _hi(g) >= 100),
    ("k", .364, lambda g: _lo(g) >= 85),
    ("k", .30, lambda g: _tot(g) >= 185),
    ("k", .236, lambda g: _tot(g) <= 160),
]
if IS_EL:
    QUESTIONS3 = QUESTIONS3_EL


def q3_param(qd, n):
    best, bd = None, 9.0
    if qd[0] == "x":
        for v, q in qd[1]:
            d = abs(_q_any(q, n) - 0.5)
            if d < bd - 1e-9:
                bd, best = d, v
    else:
        for k in range(1, n + 1):
            d = abs(_q_at_least(qd[1], n, k) - 0.5)
            if d < bd - 1e-9:
                bd, best = d, k
    return best


def q3_answer(qd, dgames):
    v = q3_param(qd, max(1, len(dgames)))
    if qd[0] == "x":
        return any(qd[2](g, v) for g in dgames)
    return sum(1 for g in dgames if qd[2](g)) >= v


def day_num(day):
    return (datetime(int(day[:4]), int(day[4:6]), int(day[6:]), tzinfo=timezone.utc).date() - datetime(1970, 1, 1).date()).days


def question_answer(day, dgames):
    if day >= Q3_FROM:
        return "y" if q3_answer(QUESTIONS3[day_num(day) % len(QUESTIONS3)], dgames) else "n"
    if day >= RULES2_FROM:
        n = day_num(day)
        return "y" if QUESTIONS2[n % len(QUESTIONS2)](dgames) else "n"
    return "y" if QUESTIONS[int(day) % len(QUESTIONS)](dgames) else "n"


SERIES_WIN, SERIES_GAMES = 3, 2  # seri kazananı +3, maç sayısı da doğruysa +2


LOCK_EXT = None   # yöneticinin uzattığı maç kilitleri: {maçId: until}


def lock_ext():
    global LOCK_EXT
    if LOCK_EXT is None:
        try:
            LOCK_EXT = {k: v.get("until") for k, v in fs_list("lockExt").items() if v.get("until")}
        except Exception as e:   # okunamazsa uzatma yok sayılır (normal kilit geçerli)
            print("lockExt okunamadı:", e, file=sys.stderr)
            LOCK_EXT = {}
    return LOCK_EXT


def pick_valid(pick, gid, start_iso, gap):
    """Maç tahmini sayılır mı: normal kilitten önce, ya da yöneticinin uzattığı süre içinde, ya da yönetici girdiyse."""
    if not pick:
        return False
    if pick.get("by"):   # kurallar "by" alanını yalnızca yöneticiye yazdırır (teknik sorun yaşayan oyuncu adına)
        return True
    if valid_before(pick, start_iso, gap):
        return True
    until = lock_ext().get(gid)
    return bool(until and pick.get("updatedAt") and ts(pick["updatedAt"]) < ts(until))


def daily_ok(daily, at_key, first_start, gap, day):
    """Gecenin seçimi (banko/günün oyuncusu/soru) sayılır mı: gecenin kilidinden önce, yöneticinin uzattığı
    süre içinde (lockExt/{gün}) ya da yönetici girdiyse."""
    if not daily or not daily.get(at_key):
        return False
    if daily.get("by"):
        return True
    at = ts(daily[at_key])
    if at < ts(first_start) - gap:
        return True
    until = lock_ext().get(day)
    return bool(until and at < ts(until))


def valid_before(doc, start_iso, gap=LOCK):
    """Tahmin kilitten önce mi kaydedildi? (sunucu saatiyle; kilit = start - gap)"""
    if not doc or not doc.get("updatedAt"):
        return False
    return ts(doc["updatedAt"]) < ts(start_iso) - gap


# ---------------------------------------------------------------- ana akış
# Sitedeki (app.js INJ_OUT_RX) ile aynı kural: durum GTD olsa da son 40 saatteki notta "ruled out" vb. varsa oynamıyor
INJ_OUT_RX = re.compile(r"ruled out|\bis out\b|\bwill be out\b|will not play|won't play|will miss|sitting out|will sit|will be rested|\bout for (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight)", re.I)


def inj_out(i):
    st = i.get("status", "")
    if st in ("Out", "Suspension"):
        return True
    try:
        d = datetime.fromisoformat((i.get("date") or "").replace("Z", "+00:00"))
        recent = datetime.now(timezone.utc) - d < timedelta(hours=40)
    except ValueError:
        recent = False
    return bool(recent and INJ_OUT_RX.search(i.get("shortComment") or ""))


INJ_TR = {"Out": "Oynamıyor", "Day-To-Day": "Belirsiz", "Suspension": "Cezalı", "Questionable": "Belirsiz", "Doubtful": "Şüpheli"}


def save_injuries():
    """Sakatlık listesi -> data/injuries.json  {oyuncuId: {s: durum, y: bölge, r: dönüş tarihi}}"""
    d = get("https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries")
    out = {}
    for t in d.get("injuries", []):
        for i in t.get("injuries", []):
            a = i.get("athlete", {})
            pid = None
            for l in a.get("links", []):
                m = re.search(r"/id/(\d+)", l.get("href", ""))
                if m:
                    pid = m.group(1); break
            if not pid:
                continue
            det = i.get("details") or {}
            st = "Cezalı" if i.get("status") == "Suspension" else "Oynamıyor" if inj_out(i) else "Belirsiz"
            out[pid] = {"s": st, "y": det.get("type", ""), "c": i.get("shortComment", ""),
                        "r": det.get("returnDate", ""), "t": a.get("team", {}).get("abbreviation", "")}
    if len(out) < 10 and len(load("injuries.json", {})) >= 30:
        raise RuntimeError(f"sakatlık listesi şüpheli derecede kısa ({len(out)}); eski liste korunuyor")
    return save("injuries.json", out)


def save_all_players():
    """Tüm NBA oyuncuları (güvenlik sorusu için seçim listesi) -> data/allplayers.json"""
    teams = get(f"{ESPN}/teams")["sports"][0]["leagues"][0]["teams"]
    out, tl = [], []
    for t in teams:
        t = t["team"]
        tl.append({"a": t["abbreviation"], "n": t["displayName"], "id": str(t["id"])})
        for a in get(f"{ESPN}/teams/{t['id']}/roster").get("athletes", []):
            x = {"id": str(a["id"]), "n": a["displayName"], "t": t["abbreviation"]}
            if (a.get("experience") or {}).get("years") == 0:
                x["r"] = 1   # çaylak
            out.append(x)
    if len(out) < 300:
        raise RuntimeError(f"yalnızca {len(out)} oyuncu geldi")
    # Listeden oyuncu silinmez (kadrodan çıkan oyuncu, onu güvenlik cevabı seçen için listede kalır).
    seen = {x["id"] for x in out}
    out += [x for x in load("allplayers.json", {}).get("players", []) if x["id"] not in seen]
    out.sort(key=lambda x: (x["n"], x["id"]))
    tl.sort(key=lambda x: x["n"])
    return save("allplayers.json", {"teams": tl, "players": out})


BBR = {"BKN": "BRK", "CHA": "CHO", "GS": "GSW", "NO": "NOP", "NY": "NYK", "PHX": "PHO", "SA": "SAS", "UTAH": "UTA", "WSH": "WAS"}


def _norm_name(n):
    import unicodedata
    n = unicodedata.normalize("NFKD", n).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", n))


def save_payroll(force=False):
    """Takas makinesi için takım maaş toplamları (Basketball-Reference sözleşme sayfaları) -> data/payroll.json
    {"at": tarih, "season": "2026-27", "t": {ESPN kısaltması: {"tot": toplam, "p": {normalize ad: maaş}}}}
    ESPN kadrosunda yeni imzalanan oyuncuların maaşı çoğu zaman boş geliyor; toplam da ölü maaşı içermiyor. Günde bir kez yenilenir."""
    old = load("payroll.json", {})
    now = datetime.now(timezone.utc)
    try:
        if not force and old.get("at") and (now - datetime.fromisoformat(old["at"])).total_seconds() < 20 * 3600:
            return False
    except Exception:
        pass
    teams = get(f"{ESPN}/teams")["sports"][0]["leagues"][0]["teams"]
    out, season = {}, ""
    for t in teams:
        a = t["team"]["abbreviation"]
        url = f"https://www.basketball-reference.com/contracts/{BBR.get(a, a)}.html"
        h = ""
        for k in range(2):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (nba-tahmin daily payroll)"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    h = r.read().decode("utf-8", "ignore")
                break
            except urllib.error.HTTPError as e:
                print("Maaş sayfası alınamadı:", a, e)
                if e.code != 429:
                    break
                time.sleep(70)
            except Exception as e:
                print("Maaş sayfası alınamadı:", a, e)
                break
        if not h:
            if a in old.get("t", {}):
                out[a] = old["t"][a]   # alınamayan takımın dünkü maaşı kalır
            time.sleep(6)
            continue
        i = h.find('id="contracts"')
        tb = h[i:h.find("</table>", i)] if i >= 0 else ""
        if not season:
            m = re.search(r'data-stat="y1"[^>]*>(\d{4}-\d{2})<', tb)
            season = m.group(1) if m else ""
        ps, tot = {}, 0
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", tb, re.S):
            cells = dict((k, re.sub(r"<[^>]+>", "", v).strip()) for k, v in re.findall(r'<t[hd][^>]*data-stat="([^"]+)"[^>]*>(.*?)</t[hd]>', row, re.S))
            nm, y1 = cells.get("player", ""), cells.get("y1", "")
            if not nm or nm == "Player":
                continue
            v = int(re.sub(r"[^0-9]", "", y1) or 0)
            if nm == "Team Totals":
                tot = v
            elif v:
                ps[_norm_name(nm)] = v
        if tot > 50e6 and ps:
            out[a] = {"tot": tot, "p": ps}
        time.sleep(6)   # Basketball-Reference dakikada 20 istekten fazlasını engelliyor
    if len(out) < 25:
        raise RuntimeError(f"yalnızca {len(out)} takımın maaşı geldi; eski liste korunuyor")
    return save("payroll.json", {"at": now.isoformat(timespec="seconds"), "season": season, "t": out})



TS_KEYS = ["avgPoints", "fieldGoalPct", "threePointPct", "avgThreePointFieldGoalsMade", "freeThrowPct", "avgRebounds", "avgOffensiveRebounds",
           "avgDefensiveRebounds", "avgAssists", "avgSteals", "avgBlocks", "avgTurnovers", "assistTurnoverRatio", "avgFouls", "twoPointFieldGoalPct"]


def save_teamstats(force=False):
    """Takım sezon istatistikleri (ESPN) -> data/teamstats.json; sitede lig sıralaması hesaplanır. Günde bir kez."""
    old = load("teamstats.json", {})
    now = datetime.now(timezone.utc)
    try:
        if not force and old.get("at") and (now - datetime.fromisoformat(old["at"])).total_seconds() < 20 * 3600:
            return False
    except Exception:
        pass
    teams = get(f"{ESPN}/teams")["sports"][0]["leagues"][0]["teams"]
    out = {}
    for t in teams:
        a, tid = t["team"]["abbreviation"], t["team"]["id"]
        try:
            d = get(f"{ESPN}/teams/{tid}/statistics")
            vals = {}
            for c in d.get("results", {}).get("stats", {}).get("categories", []):
                for x in c.get("stats", []):
                    if x.get("name") in TS_KEYS and x.get("value") is not None:
                        vals[x["name"]] = round(float(x["value"]), 3)
            if vals:
                out[a] = vals
        except Exception as e:
            print("Takım istatistiği alınamadı:", a, e)
            if a in old.get("t", {}):
                out[a] = old["t"][a]
    if len(out) < 25:
        raise RuntimeError(f"yalnızca {len(out)} takımın istatistiği geldi")
    return save("teamstats.json", {"at": now.isoformat(timespec="seconds"), "t": out})

def main(full=False):
    games = load("games.json", {})
    pstats = load("players.json", {"counted": [], "p": {}})
    PV = 5 if IS_EL else 4   # NBA v4 (1.57.1): maç kaydına kimlik, rakip, skor, dakika + savunma ribaundu, +/-, faul; EuroLeague v5 (PIR + tur), v4: maç kaydına maç kimliği, rakip, skor ve dakika da eklenir (oyuncu kartı için)
    if pstats.get("v") != PV:   # v3: maç maç kayıt + isabet yüzdeleri (uzun vade istatistikleri için); bir kere baştan kurulur
        pstats = {"v": PV, "counted": [], "p": {}}
        full = True
    counted = set(pstats["counted"])

    start = datetime.strptime(EL_SEASON_FIRST if IS_EL else CONFIG["seasonStart"], "%Y%m%d").date()
    today = espn_today()
    if any("cup" not in x or "fav" not in x for x in games.values()):   # kupa ve ESPN favorisi bilgisi eski kayıtlara bir kere eklenir
        full = True
    first = start if (full or not games) else max(start, today - timedelta(days=3))

    nights = load("nights.json", {})
    done_before = {gid for gid, g in games.items() if g.get("top")}
    # 1) biten maçlar ve kutu skorları
    d = first
    while d <= today:
        day = d.strftime("%Y%m%d")
        evs = [e for e in scoreboard(day) if e.get("season", {}).get("type") != 1]
        if evs:
            nights[day] = {"n": len(evs), "done": all(e["competitions"][0]["status"]["type"].get("state") == "post" for e in evs),
                           "first": min(e["date"] for e in evs)}
        for ev in evs:
            g = finished_game(ev)
            if not g or g["seasonType"] == 1:
                continue
            if games.get(g["id"], {}).get("top") and g["id"] in counted and "fav" in games[g["id"]]:
                games[g["id"]]["cup"] = g["cup"]
                if g.get("cupStage"):
                    games[g["id"]]["cupStage"] = g["cupStage"]
                continue
            try:
                bx = box(g["id"])
            except Exception as exc:
                print(f"Kutu skoru alınamadı {g['id']}: {exc}", file=sys.stderr)
                continue
            # Güvenlik ağı (1.30.4): kutu skoru eksik/eski ise (ESPN özeti henüz "bitti" demiyor ya da oyuncu sayıları
            # takım skoruna eşit değil) en skorer kaydedilmez; bir sonraki çalışmada yeniden denenir. Böylece yarım
            # veriyle puanlama yapılıp kalıcı olarak kilitlenmez.
            hdr = (getattr(box, "last", {}) or {}).get("header", {}).get("competitions", [{}])[0]
            if not hdr.get("status", {}).get("type", {}).get("completed"):
                print(f"Kutu skoru henüz kesin değil {g['id']}; sonra denenecek", file=sys.stderr)
                continue
            sums = {}
            for p in bx:
                sums[p["team"]] = sums.get(p["team"], 0) + p["pts"]
            if any(sums.get(g[side]["abbr"], 0) != int(g[side].get("score") or 0) for side in ("home", "away")):
                print(f"Kutu skoru takım skoruyla tutmuyor {g['id']}: {sums}; sonra denenecek", file=sys.stderr)
                continue
            top = max((p["pts"] for p in bx), default=0)
            g["fav"] = espn_fav(getattr(box, "last", {}) or {})
            hp = espn_hp(getattr(box, "last", {}) or {})
            if hp is not None:
                g["hp"] = round(hp, 4)
            winner = g.get("winner")
            g["day"] = day
            if not IS_EL:   # 1.57.1: takımların hücum sayısı (savunma ratingi = rakibin sayısı / 100 hücum)
                ps_ = team_poss(getattr(box, "last", {}) or {})
                if ps_:
                    g["poss"] = ps_
            g["top"] = [{"id": p["id"], "name": p["name"], "team": p["team"], "pts": p["pts"]} for p in bx if p["pts"] == top]
            if IS_EL:   # haftanın MVP'si için oyuncuların verimlilik puanı (PIR)
                g["pir"] = {p["id"]: [p.get("val", 0), 1 if p["team"] == winner else 0] for p in bx}
                g["round"] = (getattr(box, "last", {}) or {}).get("round")
            games[g["id"]] = g
            if g["id"] not in counted:
                for p in bx:
                    s = pstats["p"].setdefault(p["id"], {"n": p["name"], "t": p["team"], "gp": 0, "pts": 0, "reb": 0, "ast": 0, "stl": 0, "blk": 0})
                    s["n"], s["t"] = p["name"], p["team"]
                    s["gp"] += 1; s["pts"] += p["pts"]; s["reb"] += p["reb"]; s["ast"] += p["ast"]
                    s["stl"] = s.get("stl", 0) + p["stl"]; s["blk"] = s.get("blk", 0) + p["blk"]
                    for k, (m, a) in (("fg", p["fg"]), ("tp", p["tp"])):
                        s[k + "m"] = s.get(k + "m", 0) + m; s[k + "a"] = s.get(k + "a", 0) + a
                    s["l5"] = (s.get("l5", []) + [p["pts"]])[-5:]   # son 5 maçın sayıları (formda olanlar listesi için)
                    # son 16 maç: [gün, sayı, ribaund, asist, top çalma, blok, galibiyet, isabet, deneme, üçlük isabet, üçlük deneme]
                    row = [day, p["pts"], p["reb"], p["ast"], p["stl"], p["blk"], 1 if p["team"] == winner else 0,
                           p["fg"][0], p["fg"][1], p["tp"][0], p["tp"][1]]
                    if IS_EL:   # + maç kimliği, rakip, vs/@, skor (kendi-rakip), dakika
                        home = g["home"]["abbr"] == p["team"]
                        me, op = (g["home"], g["away"]) if home else (g["away"], g["home"])
                        mins = int(p["min"]) if str(p["min"]).isdigit() else 0
                        row += [g["id"], op["abbr"], "vs" if home else "@", f"{me['score']}-{op['score']}", mins]
                        s["min"] = s.get("min", 0) + mins
                    else:   # NBA: [11 maç kimliği, 12 rakip, 13 vs/@, 14 skor, 15 dakika, 16 savunma ribaundu, 17 +/-, 18 faul]
                        home = g["home"]["abbr"] == p["team"]
                        me, op = (g["home"], g["away"]) if home else (g["away"], g["home"])
                        mins = int(p["min"]) if str(p["min"]).isdigit() else 0
                        row += [g["id"], op["abbr"], "vs" if home else "@", f"{me['score']}-{op['score']}", mins,
                                p.get("dreb", 0), p.get("pm", 0), p.get("pf", 0)]
                        for k2, v2 in (("min", mins), ("dreb", p.get("dreb", 0)), ("pm", p.get("pm", 0)), ("pf", p.get("pf", 0))):
                            s[k2] = s.get(k2, 0) + v2
                    s["lg"] = (s.get("lg", []) + [row])[-16:]
                counted.add(g["id"])
        d += timedelta(days=1)
    pstats["counted"] = sorted(counted)

    # 2) puanlar — yalnızca ligin başladığı geceden itibaren (yönetim panelinden sıfırlanabilir)
    league = fs_doc("league/settings") or {}
    league_start = max(EL_START if IS_EL else CONFIG["seasonStart"], str(league.get("start") or ""))
    # deneme haftası: bitiş gecesinden sonraki gün (TR 08.00) lig kendiliğinden sıfırlanır (app.js leagueStart ile aynı an)
    trial = league.get("trial") or {}
    if isinstance(trial, dict) and trial.get("end") and not trial.get("done") and str(trial["end"]) >= league_start:
        tr_today = (datetime.now(TR_TZ) - timedelta(hours=8)).strftime("%Y%m%d")
        if tr_today > str(trial["end"]):
            nxt = (datetime.strptime(str(trial["end"]), "%Y%m%d") + timedelta(days=1)).strftime("%Y%m%d")
            league_start = max(league_start, nxt)
    # Firestore okuma kotası: yeni biten maç yoksa puanlar yeniden hesaplanmaz (gündüz saatleri boşa okumasın).
    # Güvenlik için günde bir kez (TR 11.00'den sonra) ve lig başlangıcı değişince tam hesap yapılır.
    old = load("scores.json", {})
    state = load("syncstate.json", {})
    tr_now = datetime.now(TR_TZ)
    daily_due = tr_now.hour >= 11 and state.get("full") != tr_now.strftime("%Y%m%d")
    new_done = {gid for gid, g in games.items() if g.get("top")} - done_before
    if not (full or new_done or daily_due or old.get("leagueStart") != league_start or not old.get("days")):
        changed = [save("games.json", games), save("players.json", pstats), save("nights.json", nights)]
        for fn in ((el_save_all_players,) if IS_EL else (save_injuries, save_all_players)):
            try:
                changed.append(fn())
            except Exception as e:
                print(fn.__name__, "alınamadı:", e)
        print(f"Yeni biten maç yok; puanlar yeniden hesaplanmadı (Firestore'dan yalnızca lig ayarı okundu). Değişen dosya: {sum(changed)}")
        return 0
    print("Puan hesabı:", "tam" if full else f"{len(new_done)} yeni maç" if new_done else "günlük kontrol" if daily_due else "lig başlangıcı değişti")
    players = fs_players()
    # güvenlik: oyuncu listesi boş ya da öncekinin yarısından azsa (Firestore geçici hatası) hiçbir şey yazılmaz
    old_n = len(old.get("players") or {})
    if not players or (old_n >= 4 and len(players) < old_n / 2):
        print(f"Oyuncu listesi şüpheli ({len(players)} / önceki {old_n}); puanlar bu sefer yazılmadı.", file=sys.stderr)
        return 1
    sc = {"players": players, "games": old.get("games", {}), "days": old.get("days", {})}
    # oyunda olmayan (silinmiş/test) oyuncuların kayıtlarını at
    for bucket_ in ("games", "days"):
        for k in list(sc[bucket_]):
            sc[bucket_][k] = {u: v for u, v in sc[bucket_][k].items() if u in players}
            if not sc[bucket_][k]:
                del sc[bucket_][k]
    for bucket_ in ("days",):
        for k in list(sc[bucket_]):
            if k < league_start:
                del sc[bucket_][k]
    for gid in list(sc["games"]):
        if games.get(gid, {}).get("day", "") < league_start:
            del sc["games"][gid]
    by_day = {}
    for g in games.values():
        if g["day"] >= league_start:
            by_day.setdefault(g["day"], []).append(g)

    # tahminler kilitlendikten sonra değişmez: dünden eski, tamamlanmış geceler yeniden okunmaz (Firestore okuma kotası)
    recheck_from = max(first - timedelta(days=1), today - timedelta(days=1)).strftime("%Y%m%d")
    for day, dgames in by_day.items():
        if day < recheck_from and not full and day in sc["days"] and all(g["id"] in sc["games"] for g in dgames) \
           and all(uid in sc["days"][day] for uid in players) and nights.get(day, {}).get("done"):
            continue
        first_start = min(g["start"] for g in dgames)
        night_top = max(max((t["pts"] for t in g["top"]), default=0) for g in dgames)
        # gecenin en skorerleri: her maçın en skoreri arasından en yükseği
        night_ids = {t["id"] for g in dgames for t in g["top"] if t["pts"] == night_top}
        sc["days"].setdefault(day, {})
        for uid in players:
            daily = fs_doc(f"daily/{day}_{uid}")
            conf_game = None
            if daily and daily.get("confGame") and daily.get("confAt"):
                cg = next((g for g in dgames if g["id"] == daily["confGame"]), None)
                if cg and daily_ok(daily, "confAt", first_start, lock_gap(day), day):
                    conf_game = cg["id"]
            dp = 0
            dp_name = None
            if daily and daily.get("dayPlayerId") and daily_ok(daily, "dayAt", first_start, lock_gap(day), day):
                dp_name = daily.get("dayPlayerName")
                if daily["dayPlayerId"] in night_ids:
                    dp = 3 if day >= RULES2_FROM else 2
            # gecenin sorusu: gece tamamen bittiyse
            q, qp = None, 0
            if daily and daily.get("q") in ("y", "n") and daily_ok(daily, "qAt", first_start, lock_gap(day), day):
                q = daily["q"]
                if nights.get(day, {}).get("done") and nights[day]["n"] == len(dgames):
                    qp = 1 if q == question_answer(day, dgames) else 0
            total = dp + qp
            n = 0
            for g in dgames:
                pick = fs_doc(f"picks/{g['id']}_{uid}")
                # kilit = ESPN'deki gerçek saat (sitenin yazdığı değere güvenilmez): 4 Kasım'dan itibaren maçın kendisi, öncesinde gecenin ilk maçı
                if not pick_valid(pick, g["id"], g["start"] if day >= PERGAME_FROM else first_start, lock_gap(day)) or not (pick.get("winner") and pick.get("margin") and pick.get("scorerId")):
                    pick = None
                top_ids = {t["id"] for t in g["top"]}
                r = score_game(g, pick, conf_game == g["id"], top_ids)
                n += 1 if pick else 0
                sc["games"].setdefault(g["id"], {})[uid] = r
                total += r["pts"]
            night_done = nights.get(day, {}).get("done") and nights[day]["n"] == len(dgames)
            auto = 0
            # lige sonradan katılan, katılmadan önceki gecelerde otomatik tahmin yapmış sayılır (açık olmasa da):
            # aradaki farkı biraz kapatma şansı olsun
            joined = players[uid].get("joined") or ""
            late = bool(joined) and ts(joined) >= ts(first_start) - lock_gap(day)
            if n == 0 and not q and not dp_name and not conf_game and (players[uid].get("autoPick") or late) and day >= AUTO_FROM and night_done:
                auto = auto_points(dgames)
                total += auto
            sc["days"][day][uid] = {"pts": total, "n": n + (1 if q else 0), "dp": dp, "dpName": dp_name, "conf": conf_game,
                                    "q": q, "qp": qp, "week": week_key(day), **({"auto": auto} if auto else {})}

    # playoff serileri: biten her seri, son maçının gecesine puan olarak eklenir (gün satırında "sr")
    series = {}
    for g in games.values():
        sr = g.get("series")
        if sr:
            series.setdefault(sr["key"], []).append(g)
    sc["series"] = {}
    for key, sg in series.items():
        if any(g["day"] < league_start for g in sg):
            continue  # lig sıfırlanmadan önce başlamış seri sayılmaz
        sg.sort(key=lambda g: g["start"])
        last = sg[-1]["series"]
        need = last.get("need", 4)
        winner = next((t for t, w in last["wins"].items() if w >= need), None)
        if not winner:
            continue
        total_games = sum(last["wins"].values())
        first_start, final_day = sg[0]["start"], sg[-1]["day"]
        row = {}
        for uid in players:
            sp = fs_doc(f"series/{key}_{uid}")
            if not valid_before(sp, first_start, lock_gap(sg[0]["day"])):
                continue
            pts = 0
            if sp.get("winner") == winner:
                pts = SERIES_WIN + (SERIES_GAMES if int(sp.get("games") or 0) == total_games else 0)
            row[uid] = {"pts": pts, "pick": {"w": sp.get("winner"), "g": sp.get("games")}}
        sc["series"][key] = {"winner": winner, "games": total_games, "day": final_day, "row": row}
    for day, row in sc["days"].items():
        for uid, v in row.items():
            v["sr"] = sum(x["row"].get(uid, {}).get("pts", 0) for x in sc["series"].values() if x["day"] == day)

    streak_bonus(sc["days"])
    # toplamlar (gün puanı + o gece biten serilerin puanı + devamlılık bonusu)
    for row in sc["days"].values():
        for v in row.values():
            v["tot"] = v["pts"] + v.get("sr", 0) + v.get("bon", 0)
    tot = {uid: {"pts": 0, "days": 0, "dayWins": 0, "weekWins": 0} for uid in players}
    weeks = {}
    for day, row in sc["days"].items():
        if not any(v.get("n") or v.get("dpName") for v in row.values()):
            continue  # kimsenin oynamadığı gece sayılmaz
        night = lambda x: x["tot"] - x.get("bon", 0)   # gece birinciliğine devamlılık bonusu sayılmaz
        best = max((night(v) for v in row.values()), default=None)
        for uid, v in row.items():
            if uid not in tot:
                continue
            tot[uid]["pts"] += v["tot"]
            tot[uid]["days"] += 1
            sole_best = sum(1 for x in row.values() if night(x) == best) == 1
            if night(v) == best and sole_best:
                tot[uid]["dayWins"] += 1
            weeks.setdefault(v["week"], {}).setdefault(uid, 0)
            weeks[v["week"]][uid] += v["tot"]
    # lig ödülleri: her ay bitince (Ekim, Kasım'la birlikte sayılır) ödüller ve bonus puanları
    sc["awards"] = league_awards(sc, games, players, today.strftime("%Y%m%d"), league_start)
    for a in sc["awards"].values():
        for x in a["list"]:
            for uid in x["u"]:
                if uid in tot:
                    tot[uid]["pts"] += x["pts"]
                    tot[uid]["aw"] = tot[uid].get("aw", 0) + x["pts"]
    # uzun vade puanları: toplama ve sonucun açıklandığı haftaya eklenir
    try:
        if IS_EL:
            lt, lt_days, sc["mvp"] = el_lt_scores(players, games, league_start)
        else:
            lt, lt_days = lt_scores(players, league_start)
    except Exception as e:   # alınamazsa önceki sonuçlar korunur
        print("Uzun vade puanları alınamadı, önceki değerler kullanılıyor:", e)
        lt = {u: v.get("rounds", {}) for u, v in (old.get("lt") or {}).items() if u in players}
        lt_days = old.get("ltDays") or {}
    sc["lt"] = {uid: {"total": sum(r.values()), "rounds": r} for uid, r in lt.items()}
    sc["ltDays"] = lt_days
    for uid, rounds in lt.items():
        if uid in tot:
            tot[uid]["pts"] += sum(rounds.values())
            tot[uid]["lt"] = sum(rounds.values())
        for k, p in rounds.items():
            d = lt_days.get(k)
            if d:
                weeks.setdefault(week_key(d), {}).setdefault(uid, 0)
                weeks[week_key(d)][uid] += p
    cur_week = week_key(today.strftime("%Y%m%d"))
    for wk, row in weeks.items():
        if wk == cur_week:
            continue
        best = max(row.values())
        winners = [u for u, p in row.items() if p == best]
        if len(winners) == 1 and winners[0] in tot:
            tot[winners[0]]["weekWins"] += 1
    # haftalık ilk 3 ödülü (5 / 3 / 1)
    sc["weekAwards"] = week_awards(sc, games, players, nights, cur_week)
    for lst in sc["weekAwards"].values():
        for x in lst:
            if x["u"] in tot:
                tot[x["u"]]["pts"] += x["pts"]
                tot[x["u"]]["wa"] = tot[x["u"]].get("wa", 0) + x["pts"]
    sc["totals"] = tot
    sc["leagueStart"] = league_start
    sc["weeks"] = weeks

    changed = [save("games.json", games), save("players.json", pstats), save("scores.json", sc), save("nights.json", nights)]
    if daily_due:
        changed.append(save("syncstate.json", {"full": tr_now.strftime("%Y%m%d")}))
    if IS_EL:   # yedek, sakatlık, maaş ve takım istatistikleri NBA'ye özgü
        try:
            changed.append(el_save_all_players())
        except Exception as e:   # noqa: BLE001
            print("EuroLeague kadro listesi alınamadı:", e)
        print(f"EuroLeague: {len(games)} maç, {len(players)} oyuncu. Değişen dosya: {sum(changed)}")
        return 0
    try:
        changed.append(backup(players, today))
    except Exception as e:
        print("Yedek alınamadı:", e)
    try:
        changed.append(save_injuries())
    except Exception as e:
        print("Sakatlık listesi alınamadı:", e)
    try:
        changed.append(save_all_players())
    except Exception as e:  # kadro listesi olmasa da puanlar yazılsın
        print("Kadro listesi alınamadı:", e)
    try:
        changed.append(save_payroll())
    except Exception as e:
        print("Maaş listesi alınamadı:", e)
    try:
        changed.append(save_teamstats())
    except Exception as e:
        print("Takım istatistikleri alınamadı:", e)
    print(f"{len(games)} maç, {len(players)} oyuncu. Değişen dosya: {sum(changed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(full="--full" in sys.argv))

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
DATA = os.path.join(ROOT, "data")
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
MARGIN_TOL, MARGIN_MAX = 3, 40
AUTO_FROM = "20261104"    # yedek tahmin: hiç tahmin yapmayan ve tercihi açık olana ESPN favorileri; her 2 doğru kazanan 1 puan
STREAK_NIGHTS, STREAK_BONUS = 4, 2   # devamlılık: haftada en az 4 gece kendi tahmini olana +2


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


def box(event_id: str):
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
        d = get(url, tries=2)
    except urllib.error.HTTPError:
        return {}
    return {x["name"].rsplit("/", 1)[1]: {k: fs_value(v) for k, v in x.get("fields", {}).items()} for x in d.get("documents", [])}


def lt_scores(players):
    """Sonuçlanan uzun vade turlarının puanları: {uid: {tur: puan}} ve her turun gün anahtarı."""
    out, days = {}, {}
    for k, r in fs_list("ltResults").items():
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
                st[u]["mg"] += r.get("m", 0) > 0

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
        lst.append({"k": "fark", "i": "📏", "t": "Fark ustası", "d": "Farkı en çok tutturan", "u": w, "v": f"{v} maç", "pts": 2})
        title = "Ekim-Kasım ödülleri" if mk == "202611" else f"{AY[m - 1]} ödülleri"
        out[mk] = {"title": title, "list": lst}
    return out


def backup(players, today):
    """Haftalık yedek: data/backup/<pazartesi>.json. Herkese açık okunabilen veriler (oyuncular, lig ayarları,
    uzun vade sonuçları ve kilitlenmiş uzun vade seçimleri). Gece gece tahminler zaten scores.json'da (git geçmişinde) duruyor."""
    wk = week_key(today.strftime("%Y%m%d"))
    path = os.path.join(DATA, "backup", f"{wk}.json")
    if os.path.exists(path):
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
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
    return True


def fs_players():
    url = fs_url("players?pageSize=100")
    if not url:
        return {}
    try:
        d = get(url, tries=2)
    except urllib.error.HTTPError:
        return {}
    out = {}
    for doc in d.get("documents", []):
        uid = doc["name"].rsplit("/", 1)[1]
        f = {k: fs_value(v) for k, v in doc.get("fields", {}).items()}
        out[uid] = {"name": f.get("name", "?"), "joined": f.get("joined"), "autoPick": bool(f.get("autoPick"))}
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
            r["m"] = 1
    elif conf:
        r["w"] = -1
    if pick.get("scorerId") in top_ids:
        r["s"] = 1
    r["pts"] = min(WIN_CAP, max(r["w"], 0) * mult) + (r["m"] + r["s"]) * mult + min(r["w"], 0)   # kazanan en fazla 4; yanan banko katlanmaz
    return r


LOCK = timedelta(0)  # 3 Kasım 2026 öncesi: gecenin bütün tahminleri ilk maç başlayınca kilitlenir
GAP_FROM, PERGAME_FROM = "20261103", "20261104"
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


def question_answer(day, dgames):
    if day >= RULES2_FROM:
        n = (datetime(int(day[:4]), int(day[4:6]), int(day[6:]), tzinfo=timezone.utc).date() - datetime(1970, 1, 1).date()).days
        return "y" if QUESTIONS2[n % len(QUESTIONS2)](dgames) else "n"
    return "y" if QUESTIONS[int(day) % len(QUESTIONS)](dgames) else "n"


SERIES_WIN, SERIES_GAMES = 3, 2  # seri kazananı +3, maç sayısı da doğruysa +2


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


def main(full=False):
    games = load("games.json", {})
    pstats = load("players.json", {"counted": [], "p": {}})
    if pstats.get("v") != 3:   # v3: maç maç kayıt + isabet yüzdeleri (uzun vade istatistikleri için); bir kere baştan kurulur
        pstats = {"v": 3, "counted": [], "p": {}}
        full = True
    counted = set(pstats["counted"])

    start = datetime.strptime(CONFIG["seasonStart"], "%Y%m%d").date()
    today = espn_today()
    if any("cup" not in x or "fav" not in x for x in games.values()):   # kupa ve ESPN favorisi bilgisi eski kayıtlara bir kere eklenir
        full = True
    first = start if (full or not games) else max(start, today - timedelta(days=3))

    nights = load("nights.json", {})
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
            top = max((p["pts"] for p in bx), default=0)
            g["fav"] = espn_fav(getattr(box, "last", {}) or {})
            hp = espn_hp(getattr(box, "last", {}) or {})
            if hp is not None:
                g["hp"] = round(hp, 4)
            winner = g.get("winner")
            g["day"] = day
            g["top"] = [{"id": p["id"], "name": p["name"], "team": p["team"], "pts": p["pts"]} for p in bx if p["pts"] == top]
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
                    s["lg"] = (s.get("lg", []) + [[day, p["pts"], p["reb"], p["ast"], p["stl"], p["blk"], 1 if p["team"] == winner else 0,
                                                   p["fg"][0], p["fg"][1], p["tp"][0], p["tp"][1]]])[-16:]
                counted.add(g["id"])
        d += timedelta(days=1)
    pstats["counted"] = sorted(counted)

    # 2) puanlar — yalnızca ligin başladığı geceden itibaren (yönetim panelinden sıfırlanabilir)
    league = fs_doc("league/settings") or {}
    league_start = max(CONFIG["seasonStart"], str(league.get("start") or ""))
    players = fs_players()
    old = load("scores.json", {})
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

    recheck_from = (first - timedelta(days=1)).strftime("%Y%m%d")
    for day, dgames in by_day.items():
        if day < recheck_from and not full and day in sc["days"] and all(g["id"] in sc["games"] for g in dgames) \
           and all(uid in sc["days"][day] for uid in players):
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
                if cg and ts(daily["confAt"]) < ts(first_start) - lock_gap(day):
                    conf_game = cg["id"]
            dp = 0
            dp_name = None
            if daily and daily.get("dayPlayerId") and daily.get("dayAt") and ts(daily["dayAt"]) < ts(first_start) - lock_gap(day):
                dp_name = daily.get("dayPlayerName")
                if daily["dayPlayerId"] in night_ids:
                    dp = 3 if day >= RULES2_FROM else 2
            # gecenin sorusu: gece tamamen bittiyse
            q, qp = None, 0
            if daily and daily.get("q") in ("y", "n") and daily.get("qAt") and ts(daily["qAt"]) < ts(first_start) - lock_gap(day):
                q = daily["q"]
                if nights.get(day, {}).get("done") and nights[day]["n"] == len(dgames):
                    qp = 1 if q == question_answer(day, dgames) else 0
            total = dp + qp
            n = 0
            for g in dgames:
                pick = fs_doc(f"picks/{g['id']}_{uid}")
                # kilit = ESPN'deki gerçek saat (sitenin yazdığı değere güvenilmez): 4 Kasım'dan itibaren maçın kendisi, öncesinde gecenin ilk maçı
                if not valid_before(pick, g["start"] if day >= PERGAME_FROM else first_start, lock_gap(day)) or not (pick.get("winner") and pick.get("margin") and pick.get("scorerId")):
                    pick = None
                top_ids = {t["id"] for t in g["top"]}
                r = score_game(g, pick, conf_game == g["id"], top_ids)
                n += 1 if pick else 0
                sc["games"].setdefault(g["id"], {})[uid] = r
                total += r["pts"]
            auto = 0
            night_done = nights.get(day, {}).get("done") and nights[day]["n"] == len(dgames)
            if n == 0 and not q and not dp_name and not conf_game and players[uid].get("autoPick") and day >= AUTO_FROM and night_done:
                auto = sum(1 for g in dgames if g.get("fav") and g["fav"] == g["winner"]) // 2
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

    # devamlılık bonusu: haftanın 4. kendi tahminli gecesine +2 (her çalışmada baştan hesaplanır)
    seen_nights = {}
    for day in sorted(sc["days"]):
        for uid, v in sc["days"][day].items():
            v.pop("bon", None)
            if day < AUTO_FROM or not v.get("n"):
                continue
            k = (v.get("week") or week_key(day), uid)
            seen_nights[k] = seen_nights.get(k, 0) + 1
            if seen_nights[k] == STREAK_NIGHTS:
                v["bon"] = STREAK_BONUS
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
        lt, lt_days = lt_scores(players)
    except Exception as e:
        print("Uzun vade puanları alınamadı:", e)
        lt, lt_days = {}, {}
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
    sc["totals"] = tot
    sc["leagueStart"] = league_start
    sc["weeks"] = weeks

    changed = [save("games.json", games), save("players.json", pstats), save("scores.json", sc), save("nights.json", nights)]
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
    print(f"{len(games)} maç, {len(players)} oyuncu. Değişen dosya: {sum(changed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(full="--full" in sys.argv))

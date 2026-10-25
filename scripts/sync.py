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
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

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


def box(event_id: str):
    s = get(f"{ESPN}/summary?event={event_id}")
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
    return {
        "id": ev["id"], "start": ev["date"], "seasonType": ev.get("season", {}).get("type", 2),
        "home": h, "away": a, "winner": winner,
        "margin": abs(h["score"] - a["score"]),
        "bucket": margin_bucket(abs(h["score"] - a["score"])),
    }


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
        out[uid] = {"name": f.get("name", "?"), "joined": f.get("joined")}
    return out


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------- puanlama
def score_game(g, pick, conf, top_ids):
    """Bir oyuncunun bir maçtan aldığı puan ve ayrıntısı."""
    mult = 2 if g["seasonType"] == 3 else 1          # playoff modu
    r = {"w": 0, "m": 0, "s": 0, "c": bool(conf), "pts": 0, "pick": None}
    if not pick:
        return r
    r["pick"] = {"w": pick.get("winner"), "m": pick.get("margin"), "s": pick.get("scorerName")}
    won = pick.get("winner") == g["winner"]
    if won:
        r["w"] = 2 if conf else 1
        if pick.get("margin") == g["bucket"]:
            r["m"] = 1
    elif conf:
        r["w"] = -1
    if pick.get("scorerId") in top_ids:
        r["s"] = 1
    r["pts"] = (r["w"] + r["m"] + r["s"]) * mult
    return r


LOCK = timedelta(minutes=10)  # tahminler maçtan 10 dk önce kilitlenir


def valid_before(doc, start_iso):
    """Tahmin kilitten (maçtan 10 dk önce) önce mi kaydedildi? (sunucu saatiyle)"""
    if not doc or not doc.get("updatedAt"):
        return False
    return ts(doc["updatedAt"]) < ts(start_iso) - LOCK


# ---------------------------------------------------------------- ana akış
def main(full=False):
    games = load("games.json", {})
    pstats = load("players.json", {"counted": [], "p": {}})
    counted = set(pstats["counted"])

    start = datetime.strptime(CONFIG["seasonStart"], "%Y%m%d").date()
    today = espn_today()
    first = start if (full or not games) else max(start, today - timedelta(days=3))

    # 1) biten maçlar ve kutu skorları
    d = first
    while d <= today:
        day = d.strftime("%Y%m%d")
        for ev in scoreboard(day):
            g = finished_game(ev)
            if not g or g["seasonType"] == 1:
                continue
            if g["id"] in games and games[g["id"]].get("top"):
                continue
            try:
                bx = box(g["id"])
            except Exception as exc:
                print(f"Kutu skoru alınamadı {g['id']}: {exc}", file=sys.stderr)
                continue
            top = max((p["pts"] for p in bx), default=0)
            g["day"] = day
            g["top"] = [{"id": p["id"], "name": p["name"], "team": p["team"], "pts": p["pts"]} for p in bx if p["pts"] == top]
            games[g["id"]] = g
            if g["id"] not in counted:
                for p in bx:
                    s = pstats["p"].setdefault(p["id"], {"n": p["name"], "t": p["team"], "gp": 0, "pts": 0, "reb": 0, "ast": 0})
                    s["n"], s["t"] = p["name"], p["team"]
                    s["gp"] += 1; s["pts"] += p["pts"]; s["reb"] += p["reb"]; s["ast"] += p["ast"]
                counted.add(g["id"])
        d += timedelta(days=1)
    pstats["counted"] = sorted(counted)

    # 2) puanlar
    players = fs_players()
    old = load("scores.json", {})
    sc = {"players": players, "games": old.get("games", {}), "days": old.get("days", {})}
    # oyunda olmayan (silinmiş/test) oyuncuların kayıtlarını at
    for bucket_ in ("games", "days"):
        for k in list(sc[bucket_]):
            sc[bucket_][k] = {u: v for u, v in sc[bucket_][k].items() if u in players}
            if not sc[bucket_][k]:
                del sc[bucket_][k]
    by_day = {}
    for g in games.values():
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
                if cg and ts(daily["confAt"]) < ts(cg["start"]) - LOCK:
                    conf_game = cg["id"]
            dp = 0
            dp_name = None
            if daily and daily.get("dayPlayerId") and daily.get("dayAt") and ts(daily["dayAt"]) < ts(first_start) - LOCK:
                dp_name = daily.get("dayPlayerName")
                if daily["dayPlayerId"] in night_ids:
                    dp = 2
            total = dp
            n = 0
            for g in dgames:
                pick = fs_doc(f"picks/{g['id']}_{uid}")
                if not valid_before(pick, g["start"]) or not (pick.get("winner") and pick.get("margin") and pick.get("scorerId")):
                    pick = None
                top_ids = {t["id"] for t in g["top"]}
                r = score_game(g, pick, conf_game == g["id"], top_ids)
                n += 1 if pick else 0
                sc["games"].setdefault(g["id"], {})[uid] = r
                total += r["pts"]
            sc["days"][day][uid] = {"pts": total, "n": n, "dp": dp, "dpName": dp_name, "conf": conf_game,
                                    "week": week_key(day)}

    # toplamlar
    tot = {uid: {"pts": 0, "days": 0, "dayWins": 0, "weekWins": 0} for uid in players}
    weeks = {}
    for day, row in sc["days"].items():
        if not any(v.get("n") or v.get("dpName") for v in row.values()):
            continue  # kimsenin oynamadığı gece sayılmaz
        best = max((v["pts"] for v in row.values()), default=None)
        for uid, v in row.items():
            if uid not in tot:
                continue
            tot[uid]["pts"] += v["pts"]
            tot[uid]["days"] += 1
            sole_best = sum(1 for x in row.values() if x["pts"] == best) == 1
            if v["pts"] == best and sole_best:
                tot[uid]["dayWins"] += 1
            weeks.setdefault(v["week"], {}).setdefault(uid, 0)
            weeks[v["week"]][uid] += v["pts"]
    cur_week = week_key(today.strftime("%Y%m%d"))
    for wk, row in weeks.items():
        if wk == cur_week:
            continue
        best = max(row.values())
        winners = [u for u, p in row.items() if p == best]
        if len(winners) == 1 and winners[0] in tot:
            tot[winners[0]]["weekWins"] += 1
    sc["totals"] = tot
    sc["weeks"] = weeks

    changed = [save("games.json", games), save("players.json", pstats), save("scores.json", sc)]
    print(f"{len(games)} maç, {len(players)} oyuncu. Değişen dosya: {sum(changed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(full="--full" in sys.argv))

"""Uzun vade sonuçlarını otomatik doldurur (remind.py içinden, saatte bir).

Kaynak: Wikipedia'daki sezon sayfası ("2026–27 NBA season") ve kupa sayfası ("2026 NBA Cup").
Bu sayfalar ödül açıklandıktan kısa süre sonra güncellenir:
  - Players of the Week          -> w_<pazartesi>   e / w
  - Players of the Month         -> m_<yıl ay>      pe / pw
  - Rookies of the Month         -> m_...           re / rw
  - Defensive Players of the Month -> m_...         de / dw
  - Yearly awards                -> s_2027          mvp, dpoy, roy, smoy, mip, coy (koçun takımı)
  - Kupa bilgi kutusu            -> c_2026          cw (şampiyon), cfe / cfw (finalistler), cmvp
Oyuncu adları data/allplayers.json ile ESPN kimliğine çevrilir. Yönetim panelinden elle kaydedilmiş
(manual: true) bir tura dokunulmaz. Yazılan alanlar ltResults/{tur} belgesine eklenir; ilk yazışta
"at" (açıklanma zamanı) konur, puanlar o haftaya sayılır.
"""
import re
import urllib.parse
from datetime import datetime

from firebase_admin import firestore

from sync import load, week_key

SEASON_PAGE = "2026–27 NBA season"
CUP_PAGE = "2026 NBA Cup"
EAST = {"ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DET", "IND", "MIA", "MIL", "NY", "ORL", "PHI", "TOR", "WSH"}
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                         "september", "october", "november", "december"], 1)}


def _text(url):
    import urllib.request
    r = urllib.request.Request(url, headers={"User-Agent": "nba-tahmin/1.0 (friends league; github.com/andacdlgn/nba-tahmin)"})
    with urllib.request.urlopen(r, timeout=30) as f:
        return f.read().decode("utf-8")


def fold(s):
    s = s.lower()
    for a, b in (("ć", "c"), ("č", "c"), ("ş", "s"), ("ö", "o"), ("ü", "u"), ("ğ", "g"), ("ı", "i"), ("é", "e"), ("á", "a"),
                 ("ñ", "n"), ("ģ", "g"), ("ž", "z"), ("š", "s"), ("ū", "u"), ("ā", "a"), ("ō", "o")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z]", "", s)


def clean(cell):
    """'[[Tyrese Maxey]] ([[Philadelphia 76ers]]) {{small|(1/2)}}' -> ('Tyrese Maxey', 'Philadelphia 76ers')"""
    cell = re.sub(r"<ref[^>]*/>|<ref.*?</ref>", "", cell, flags=re.S)
    cell = re.sub(r"\{\{small\|\(?([^}]*?)\)?\}\}", r"(\1)", cell)
    cell = re.sub(r"\{\{[^}]*\}\}", "", cell)
    cell = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", cell)
    m = re.match(r"\s*(.+?)\s*\((.+?)\)", cell)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return cell.strip(), ""


class Directory:
    def __init__(self):
        ap = load("allplayers.json", {})
        self.players = ap.get("players", [])
        self.teams = ap.get("teams", [])
        self.by_nick = {fold(t["n"].split()[-1]): t["a"] for t in self.teams}

    def team(self, name):
        return self.by_nick.get(fold((name or "").split()[-1])) if name else None

    def player(self, name, team_name=""):
        f, abbr = fold(name), self.team(team_name)
        hits = [p for p in self.players if fold(p["n"]) == f]
        if len(hits) == 1:
            return hits[0]
        last = fold(name.split()[-1]) if name.split() else ""
        cand = [p for p in self.players if fold(p["n"].split()[-1]) == last and (not abbr or p["t"] == abbr)]
        if len(cand) == 1:
            return cand[0]
        return hits[0] if hits else None


def section(text, title):
    m = re.search(r"^=+\s*" + re.escape(title) + r"\s*=+\s*$", text, re.M | re.I)
    if not m:
        return ""
    rest = text[m.end():]
    n = re.search(r"^=+[^=\n]+=+\s*$", rest, re.M)
    return rest[: n.start()] if n else rest


def table_rows(sec):
    """wikitable satırları: [ilk hücre, doğu, batı]"""
    rows = []
    for chunk in sec.split("\n|-")[1:]:
        cells = [c for c in re.split(r"\n\|(?!\})", "\n" + chunk.strip()) if c.strip() and not c.strip().startswith("!")]
        cells = [re.sub(r'^\s*style\s*=\s*"[^"]*"\s*\|', "", c).strip() for c in cells]
        if len(cells) >= 3:
            rows.append(cells[:3])
    return rows


def week_round(label, year_start=2026):
    label = re.sub(r"\{\{[^|}]*\|?|\}\}", " ", label)
    m = re.search(r"([A-Za-z]+)\s+(\d{1,2})", label)
    if not m or m.group(1).lower() not in MONTHS:
        return None
    mon, day = MONTHS[m.group(1).lower()], int(m.group(2))
    year = year_start if mon >= 8 else year_start + 1
    d = datetime(year, mon, day)
    return "w_" + week_key(d.strftime("%Y%m%d"))


def month_round(label, year_start=2026):
    label = re.sub(r"\{\{[^|}]*\|?|\}\}", " ", label).lower()
    names = [m for m in MONTHS if m in label]
    if not names:
        return None
    mon = max(MONTHS[m] for m in names) if not ("october" in label and "november" in label) else 11
    year = year_start if mon >= 8 else year_start + 1
    return f"m_{year}{mon:02d}"


def finals_results(games):
    """[(tur, kategori, takım)]: 2027 playoff'larında Doğu ile Batı takımının oynadığı seri NBA Finali'dir."""
    series = {}
    for g in games.values():
        sr = g.get("series")
        if g.get("seasonType") == 3 and sr and g.get("start", "") >= "2027-04":
            series.setdefault(sr["key"], []).append(g)
    out = []
    for key, sg in series.items():
        teams = {sg[0]["home"]["abbr"], sg[0]["away"]["abbr"]}
        east = [t for t in teams if t in EAST]
        if len(teams) != 2 or len(east) != 1:
            continue
        west = (teams - set(east)).pop()
        out += [("s_2027", "fe", east[0]), ("s_2027", "fw", west)]
        last = max(sg, key=lambda g: g["start"])["series"]
        champ = next((t for t, w in last.get("wins", {}).items() if w >= last.get("need", 4)), None)
        if champ:
            out.append(("s_2027", "champ", champ))
    return out


def collect(dir_):
    """{tur: {kategori: (kimlik, ad)}}"""
    out = {}
    text = _text("https://en.wikipedia.org/w/index.php?" + urllib.parse.urlencode({"title": SEASON_PAGE, "action": "raw"}))

    def put(k, c, ident, name):
        if k and ident:
            out.setdefault(k, {})[c] = (ident, name)

    for title, kind, cats in (("Players of the Week", "w", ("e", "w")), ("Players of the Month", "m", ("pe", "pw")),
                              ("Rookies of the Month", "m", ("re", "rw")), ("Defensive Players of the Month", "m", ("de", "dw"))):
        for label, east, west in table_rows(section(text, title)):
            k = week_round(label) if kind == "w" else month_round(label)
            for cell, c in ((east, cats[0]), (west, cats[1])):
                name, team = clean(cell)
                p = dir_.player(name, team) if name else None
                if p:
                    put(k, c, p["id"], p["n"])

    yearly = {"most valuable player": "mvp", "defensive player of the year": "dpoy", "rookie of the year": "roy",
              "sixth man of the year": "smoy", "most improved player": "mip", "coach of the year": "coy"}
    for chunk in section(text, "Yearly awards").split("\n|-")[1:]:
        parts = [x.strip() for x in re.split(r"\|\||\n\|", chunk) if x.strip()]
        if len(parts) < 2:
            continue
        award = clean(parts[0])[0].lower()
        c = next((v for k2, v in yearly.items() if k2 in award), None)
        if not c:
            continue
        name, team = clean(parts[1])
        if c == "coy":
            a = dir_.team(team)
            put("s_2027", c, a, team)
        else:
            p = dir_.player(name, team)
            if p:
                put("s_2027", c, p["id"], p["n"])

    try:
        cup = _text("https://en.wikipedia.org/w/index.php?" + urllib.parse.urlencode({"title": CUP_PAGE, "action": "raw"}))
    except Exception:
        cup = ""
    box = {}
    for line in cup.split("\n"):
        m = re.match(r"\|\s*(champions|runners-up1|mvp)\s*=\s*(.*)", line)
        if m:
            box[m.group(1)] = m.group(2)
    champ = dir_.team(clean(box.get("champions", ""))[0].replace("(1st title)", "").strip()) if box.get("champions") else None
    runner = dir_.team(clean(box.get("runners-up1", ""))[0]) if box.get("runners-up1") else None
    if champ:
        put("c_2026", "cw", champ, champ)
        for t in (champ, runner):
            if t:
                put("c_2026", "cfe" if t in EAST else "cfw", t, t)
    if box.get("mvp"):
        name, team = clean(box["mvp"])
        p = dir_.player(name, team)
        if p:
            put("c_2026", "cmvp", p["id"], p["n"])
    # NBA Finali: Doğu ve Batı takımı karşılaşan playoff serisi (data/games.json'dan). Final başlayınca konferans
    # şampiyonları (fe / fw), seri bitince NBA şampiyonu (champ) yazılır.
    for k, c, ident in finals_results(load("games.json", {})):
        put("s_2027", c, ident, ident)
    # konferans sıralaması: normal sezon bitince (13 Nisan 2027'den sonra) ESPN puan durumundan ilk 8
    if False:   # konferans sıralaması turu 1.9.1'de kaldırıldı
        try:
            import json as _j
            st = _j.loads(_text("https://site.web.api.espn.com/apis/v2/sports/basketball/nba/standings?level=2"))
            for conf in st.get("children", []):
                c = "e" if "East" in conf.get("name", "") else "w"
                for e in conf.get("standings", {}).get("entries", []):
                    seed = next((int(float(x.get("value", 0))) for x in e.get("stats", []) if x.get("name") == "playoffSeed"), 0)
                    if 1 <= seed <= 8:
                        abbr = e["team"]["abbreviation"]
                        put("k_2027", f"{c}{seed}", abbr, abbr)
        except Exception as e:
            print("konferans sıralaması alınamadı:", type(e).__name__)
    return out


def auto_awards(db, dry=False):
    try:
        found = collect(Directory())
    except Exception as e:
        print("ödüller alınamadı:", type(e).__name__, e)
        return
    for k, cats in found.items():
        if not re.match(r"^(w_\d{8}|m_\d{6}|c_2026|k_2027|s_2027)$", k) or (k[0] == "w" and k < "w_20261102") or (k[0] == "m" and k < "m_202611"):
            continue
        ref = db.collection("ltResults").document(k)
        cur = ref.get().to_dict() or {}
        if cur.get("manual"):
            continue
        patch, names = {}, dict(cur.get("names") or {})
        for c, (ident, name) in cats.items():
            if str(cur.get(c, "")) != str(ident):
                patch[c] = str(ident)
                names[c] = name
        if not patch:
            continue
        patch["names"] = names
        patch["auto"] = True
        if not cur.get("at"):
            patch["at"] = firestore.SERVER_TIMESTAMP
        print("ödül:", k, {c: names.get(c) for c in patch if c not in ("names", "auto", "at")})
        if not dry:
            ref.set(patch, merge=True)

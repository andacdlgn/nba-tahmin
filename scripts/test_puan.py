"""Puanlama tutarlılık testi: sitedeki (app.js) ve arka plandaki (sync.py) puan hesabı aynı sonucu veriyor mu?

Çalıştırma:  python scripts/test_puan.py      (node gerekir)
Kapsam: kazanan/fark/en skorer, banko (+2 / -1), playoff 2 kat, NBA Kupası 2 kat (4 Kasım 2026'dan itibaren),
kilit kuralı (3 Kasım öncesi gecenin ilk maçı, 3 Kasım 10 dk önce, 4 Kasım'dan itibaren her maç kendi saatinden 10 dk önce).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sync  # noqa: E402

APP = open(os.path.join(HERE, "..", "app.js"), encoding="utf-8").read()


def js_func(name):
    m = re.search(r"function " + name + r"\(.*?\n}\n", APP, re.S)
    if not m:
        raise SystemExit(f"app.js içinde {name} bulunamadı")
    return m.group(0)


def js_const(name):
    m = re.search(r"^const " + name + r" = .*?;\s*$", APP, re.M)
    if not m:
        raise SystemExit(f"app.js içinde {name} bulunamadı")
    return m.group(0)


CASES = []
for day, st in (("20261102", 2), ("20261106", 2), ("20261030", 2), ("20270420", 3)):
    for cup in (False, True):
        for winner, margin in (("BOS", 4), ("NY", 12), ("BOS", 18), ("BOS", 2), ("NY", 6), ("BOS", 25), ("BOS", 8), ("BOS", 37), ("NY", 9)):
            for pick in ({"winner": "BOS", "margin": "1-5", "scorerId": "1"}, {"winner": "NY", "margin": "11-15", "scorerId": "2"},
                         {"winner": "BOS", "margin": "16+", "scorerId": "3"}, {"winner": "BOS", "margin": "1-3", "scorerId": "1"},
                         {"winner": "NY", "margin": "8-12", "scorerId": "1"}, {"winner": "BOS", "margin": "13-19", "scorerId": "2"}, {"winner": "NY", "margin": "4-7", "scorerId": "2"},
                         {"winner": "BOS", "margin": "5", "scorerId": "1"}, {"winner": "BOS", "margin": "15", "scorerId": "2"}, {"winner": "NY", "margin": "9", "scorerId": "1"}, {"winner": "BOS", "margin": "40", "scorerId": "1"}, None):
                for conf in (False, True):
                    for hp in (None, 0.85, 0.75, 0.5, 0.25, 0.12):   # ev sahibi BOS'un maç önü şansı (sürpriz kademesi)
                        CASES.append({"day": day, "seasonType": st, "cup": cup, "winner": winner, "margin": margin, "pick": pick, "conf": conf, "tops": ["1"], "hp": hp})


def py_score(c):
    g = {"seasonType": c["seasonType"], "cup": c["cup"], "day": c["day"], "winner": c["winner"], "margin": c["margin"], "bucket": sync.margin_bucket(c["margin"]), "home": {"abbr": "BOS"}, "away": {"abbr": "NY"}, **({"hp": c["hp"]} if c["hp"] is not None else {})}
    r = sync.score_game(g, c["pick"], c["conf"], set(c["tops"]))
    return [r["w"], r["m"], r["s"], r["pts"]]


def js_scores():
    src = "\n".join([
        "const PERGAME_FROM = Date.UTC(2026,10,4,12);",
        js_const("CUP2X_FROM"), js_const("multOf"), js_const("bucket"), js_const("MARGINS2"), js_const("bucket2"), "const MARGIN_TOL = 3, MARGIN_MAX = 40;", js_const("marginHit"),
        "const topsOf = g => g._tops; const liveTops = g => g._tops; const S = {sums:{}};",
        js_const("TIER_FROM, WIN_CAP") if False else "const TIER_FROM = '20261104', WIN_CAP = 4;", js_const("pad") if "const pad" in APP else "const pad = n => String(n).padStart(2,'0');", js_const("ymd"), js_const("gameDayOf"), js_func("homeProb"), js_func("tierOf"),
        js_func("scorePick"),
        "const cases = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));",
        "const out = cases.map(c => { const home = c.winner === 'BOS' ? {abbr:'BOS', score:100+c.margin} : {abbr:'BOS', score:100};",
        "  const away = c.winner === 'NY' ? {abbr:'NY', score:100+c.margin} : {abbr:'NY', score:100};",
        "  const g = {seasonType:c.seasonType, cup:c.cup, day:c.day, state:'post', home, away, _tops:c.tops.map(id=>({id})), ...(c.hp!=null?{hp:c.hp}:{})};",
        "  const r = scorePick(g, c.pick, c.conf); return [r.w, r.m, r.s, r.pts]; });",
        "console.log(JSON.stringify(out));",
    ])
    with tempfile.TemporaryDirectory() as d:
        js, data = os.path.join(d, "t.cjs"), os.path.join(d, "c.json")
        open(js, "w").write(src)
        open(data, "w").write(json.dumps(CASES))
        return json.loads(subprocess.check_output(["node", js, data]))


def lock_cases():
    """Kilit: sync.valid_before ile app.js kuralının aynı anı kullanması."""
    bad = 0
    for day, first, game in (("20261102", "2026-11-03T00:00Z", "2026-11-03T02:30Z"), ("20261103", "2026-11-04T00:00Z", "2026-11-04T03:00Z"),
                             ("20261104", "2026-11-05T00:00Z", "2026-11-05T03:00Z")):
        gap = sync.lock_gap(day)
        ref = game if day >= sync.PERGAME_FROM else first
        lock = sync.ts(ref) - gap
        expect = {"20261102": sync.ts(first), "20261103": sync.ts(first) - timedelta(minutes=10),
                  "20261104": sync.ts(game) - timedelta(minutes=10)}[day]
        if lock != expect:
            bad += 1
            print("KİLİT FARKLI:", day, lock, expect)
        for dt, ok in ((-1, True), (1, False)):
            doc = {"updatedAt": (lock + timedelta(seconds=dt)).isoformat().replace("+00:00", "Z")}
            if sync.valid_before(doc, ref, gap) != ok:
                bad += 1
                print("valid_before hatalı:", day, dt)
    return bad


def main():
    js = js_scores()
    bad = 0
    for c, a in zip(CASES, js):
        p = py_score(c)
        if p != a:
            bad += 1
            if bad <= 10:
                print("FARK:", c, "python", p, "site", a)
    bad += lock_cases()
    print(f"{len(CASES)} puan durumu + kilit kontrolleri: {'hepsi aynı ✓' if not bad else str(bad) + ' fark ✗'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

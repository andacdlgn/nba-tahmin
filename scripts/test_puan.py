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
from datetime import timedelta

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
for day, st in (("20261102", 2), ("20261106", 2), ("20261030", 2), ("20261110", 2), ("20270420", 3)):
    for cup in (False, True):
        for winner, margin in (("BOS", 4), ("NY", 12), ("BOS", 18), ("BOS", 2), ("NY", 6), ("BOS", 25), ("BOS", 8), ("BOS", 37), ("NY", 9)):
            for pick in ({"winner": "BOS", "margin": "1-5", "scorerId": "1"}, {"winner": "NY", "margin": "11-15", "scorerId": "2"},
                         {"winner": "BOS", "margin": "16+", "scorerId": "3"}, {"winner": "BOS", "margin": "1-3", "scorerId": "1"},
                         {"winner": "NY", "margin": "8-12", "scorerId": "1"}, {"winner": "BOS", "margin": "13-19", "scorerId": "2"}, {"winner": "NY", "margin": "4-7", "scorerId": "2"},
                         {"winner": "BOS", "margin": "5", "scorerId": "1"}, {"winner": "BOS", "margin": "15", "scorerId": "2"}, {"winner": "NY", "margin": "9", "scorerId": "1"}, {"winner": "BOS", "margin": "40", "scorerId": "1"}, {"winner": "BOS", "margin": "8", "scorerId": "2"}, {"winner": "BOS", "margin": "37", "scorerId": "1"}, None):
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
        js_const("CUP2X_FROM"), js_const("multOf"), js_const("bucket"), js_const("MARGINS2"), js_const("bucket2"), "const MARGIN_TOL = 3, MARGIN_MAX = 40;", js_const("EXACT_FROM"), js_const("marginExact"), js_const("marginHit"),
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


def extra_cases():
    """Yedek tahmin ve devamlılık bonusu (yalnızca arka plan görevinde hesaplanır)."""
    bad = []
    gs = [{"fav": "A", "winner": "A"}, {"fav": "B", "winner": "C"}, {"fav": "D", "winner": "D"}, {"fav": "E", "winner": "E"}, {"winner": "F"}]
    if sync.auto_points(gs) != 1:
        bad.append("yedek: 3 favori kazandı -> 1 puan olmalı")
    if sync.auto_points(gs[:1]) != 0:
        bad.append("yedek: 1 favori -> 0 puan olmalı")
    wk = "20261109"
    days = {d: {"u": {"n": n, "week": wk, "pts": 0}} for d, n in (("20261109", 3), ("20261110", 0), ("20261111", 2), ("20261112", 1), ("20261113", 4), ("20261114", 2))}
    sync.streak_bonus(days)
    got = {d: v["u"].get("bon", 0) for d, v in days.items()}
    if got != {"20261109": 0, "20261110": 0, "20261111": 0, "20261112": 0, "20261113": 2, "20261114": 0}:
        bad.append(f"devamlılık: 4. gecede +2 bekleniyordu, çıkan {got}")
    sync.streak_bonus(days)   # ikinci kez çalışınca iki kat olmamalı
    if sum(v["u"].get("bon", 0) for v in days.values()) != 2:
        bad.append("devamlılık: tekrar hesaplamada bonus birikti")
    old = {"20261103": {"u": {"n": 1, "week": "20261102"}}, "20261102": {"u": {"n": 1, "week": "20261102"}}}
    sync.streak_bonus(old)
    if any(v["u"].get("bon") for v in old.values()):
        bad.append("devamlılık: 4 Kasım öncesi sayılmamalı")
    # NBA Finali: Doğu-Batı serisi konferans şampiyonlarını ve şampiyonu verir
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import awards
        G = {}
        for i, (h, a_, wins, st) in enumerate((("BOS", "NY", {"BOS": 4, "NY": 1}, "2027-05-20"), ("OKC", "BOS", {"OKC": 3, "BOS": 4}, "2027-06-15"), ("OKC", "BOS", {"OKC": 3, "BOS": 3}, "2027-06-12"))):
            G[str(i)] = {"seasonType": 3, "start": st, "home": {"abbr": h}, "away": {"abbr": a_}, "series": {"key": "2027-" + "-".join(sorted((h, a_))), "wins": wins, "need": 4}}
        got = sorted(awards.finals_results(G))
        if got != [("s_2027", "champ", "BOS"), ("s_2027", "fe", "BOS"), ("s_2027", "fw", "OKC")]:
            bad.append(f"final: beklenmeyen sonuç {got}")
    except ImportError as e:
        print("awards testi atlandı:", e)
    return bad


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


def question_cases():
    """Gecenin sorusu (5 Kasım'dan itibaren): site ve arka plan aynı eşiği seçip aynı cevabı veriyor mu; cevaplar dengeli mi?"""
    import random
    m = re.search(r"/\* Q3 START \*/(.*?)/\* Q3 END \*/", APP, re.S)
    if not m:
        return ["app.js içinde Q3 bloğu bulunamadı"]
    rnd = random.Random(7)
    nights = []
    for n in range(1, 17):
        for _ in range(12):
            gs = []
            for i in range(n):
                h, a = rnd.randint(88, 140), rnd.randint(88, 140)
                if h == a:
                    h += 1
                gs.append({"home": {"abbr": f"H{i}", "score": h}, "away": {"abbr": f"A{i}", "score": a}, "top": [{"pts": rnd.randint(18, 52)}]})
            nights.append(gs)
    src = "\n".join([
        "const UI_EN = false; const S = {days:{}};",
        "const topPts = g => Math.max(0, ...g.top.map(t=>t.pts)); const gMargin = g => Math.abs((g.home.score??0)-(g.away.score??0));",
        m.group(1),
        "const nights = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));",
        "const par = QUESTIONS3.map(d => Array.from({length:16}, (_, i) => q3Param(d, i+1)));",
        "const ans = nights.map(gs => QUESTIONS3.map(d => q3Build(d, gs.length).f(gs) ? 'y' : 'n'));",
        "const txt = QUESTIONS3.map(d => [1,4,15].map(n => q3Build(d, n).t));",
        "console.log(JSON.stringify({par, ans, txt}));",
    ])
    with tempfile.TemporaryDirectory() as d:
        js, data = os.path.join(d, "q.cjs"), os.path.join(d, "n.json")
        open(js, "w").write(src)
        open(data, "w").write(json.dumps(nights))
        out = json.loads(subprocess.check_output(["node", js, data]))
    bad = []
    if len(sync.QUESTIONS3) != len(out["par"]):
        return [f"soru sayısı farklı: python {len(sync.QUESTIONS3)}, site {len(out['par'])}"]
    for i, qd in enumerate(sync.QUESTIONS3):
        py = [sync.q3_param(qd, n) for n in range(1, 17)]
        if py != out["par"][i]:
            bad.append(f"soru {i}: eşik farklı python {py} site {out['par'][i]}")
        for n in range(2, 17):   # dengeli mi: seçilen eşikte evet ihtimali
            v = py[n - 1]
            pr = sync._q_any(qd[1][[x for x, _ in qd[1]].index(v)][1], n) if qd[0] == "x" else sync._q_at_least(qd[1], n, v)
            if not 0.25 <= pr <= 0.75:
                bad.append(f"soru {i}, {n} maç: evet ihtimali %{round(pr * 100)} (dengesiz)")
    for gs, a in zip(nights, out["ans"]):
        for g in gs:
            g["margin"] = abs(g["home"]["score"] - g["away"]["score"])
            g["winner"] = g["home"]["abbr"] if g["home"]["score"] > g["away"]["score"] else g["away"]["abbr"]
        py = ["y" if sync.q3_answer(qd, gs) else "n" for qd in sync.QUESTIONS3]
        if py != a:
            bad.append(f"{len(gs)} maçlık gece: cevap farklı")
            break
    print("Örnek sorular (1 / 4 / 15 maç):")
    for t in out["txt"]:
        print("  ·", " | ".join(t))
    return bad


def main():
    js = js_scores()
    bad = 0
    qb = question_cases()
    for x in qb:
        print("SORU:", x)
    bad += len(qb)
    for c, a in zip(CASES, js):
        p = py_score(c)
        if p != a:
            bad += 1
            if bad <= 10:
                print("FARK:", c, "python", p, "site", a)
    bad += lock_cases()
    ex = extra_cases()
    for x in ex:
        print("HATA:", x)
    bad += len(ex)
    print(f"{len(CASES)} puan durumu + kilit, yedek tahmin ve devamlılık kontrolleri: {'hepsi doğru ✓' if not bad else str(bad) + ' fark ✗'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

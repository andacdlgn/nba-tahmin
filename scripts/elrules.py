"""firestore.rules içindeki EuroLeague kurallarını üretir (1.55.0).

EuroLeague modu (?lg=el) aynı uygulamayı ayrı koleksiyonlarla çalıştırır: picks yerine el_picks, chat yerine
el_chat ... (app.js'te EL_NS). Bu betik NBA kurallarındaki ilgili match bloklarını kopyalar, koleksiyon adlarının
başına el_ ekler ve "oyuncu mu" denetimini EuroLeague profiline (elPlayers) bağlar. NBA kuralı değişince yeniden
çalıştır: python3 scripts/elrules.py  (kontrol için: --check, değişiklik gerekiyorsa çıkış 1)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES = ROOT / "firestore.rules"
# app.js'teki EL_NS ile aynı olmalı
EL_NS = ["picks", "daily", "progress", "league", "talk", "series", "chat", "chatpin", "chatlim", "typing", "dm",
         "polls", "lt", "ltResults", "ft", "reports"]
BEGIN = "    // ---- EuroLeague (otomatik üretildi: scripts/elrules.py; elle değiştirme) ----"
END = "    // ---- EuroLeague sonu ----"


def block(text, start):
    """start'taki 'match' satırından eşleşen kapanış süslü parantezine kadar."""
    i = text.index("} {", start) + 2   # "match /x/{id} {" satırının gövdesini açan parantez
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[start:j + 1]
    raise ValueError("kapanmayan blok")


def el_block(b):
    for n in EL_NS:
        b = b.replace(f"documents/{n}/", f"documents/el_{n}/")
    b = re.sub(r"^(\s*)match /(\w+)/", lambda m: f"{m.group(1)}match /el_{m.group(2)}/", b, count=1)
    b = b.replace("documents/players/", "documents/elPlayers/")
    b = b.replace("isPlayer()", "isElPlayer()").replace("dmPath(", "elDmPath(").replace("pollPath(", "elPollPath(")
    return b


def generate(text):
    base = text.split(BEGIN)[0] if BEGIN in text else text
    out = [BEGIN,
           "    function isElPlayer() { return signedIn() && exists(/databases/$(database)/documents/elPlayers/$(request.auth.uid)); }",
           "    function elDmPath(pid) { return /databases/$(database)/documents/el_dm/$(pid); }",
           "    function elPollPath(pid) { return /databases/$(database)/documents/el_polls/$(pid); }"]
    for n in EL_NS:
        m = re.search(rf"^    match /{n}/\{{", base, re.M)
        if not m:
            raise SystemExit(f"firestore.rules içinde match /{n}/ bulunamadı")
        out.append(el_block(block(base, m.start())))
    out.append(END)
    gen = "\n".join(out) + "\n"
    if BEGIN in text:
        pre, rest = text.split(BEGIN, 1)
        post = rest.split(END, 1)[1].lstrip("\n")
        return pre + gen + post
    # ilk kez: dosyanın son iki kapanışından ("  }" ve "}") önce ekle
    return text[:text.rstrip().rindex("  }")] + gen + "  }\n}\n"


if __name__ == "__main__":
    t = RULES.read_text("utf-8")
    new = generate(t)
    if "--check" in sys.argv:
        sys.exit(0 if new == t else 1)
    RULES.write_text(new, "utf-8")
    print("EuroLeague kuralları güncellendi." if new != t else "Değişiklik yok.")

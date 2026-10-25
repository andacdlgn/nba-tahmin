"""Sürüm numarasını her yerde birden artırır: python scripts/surum.py v6
(app.js VERSION, index.html BUILD ve ?v= numaraları, version.json)."""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
v = sys.argv[1] if len(sys.argv) > 1 else None
if not v or not re.fullmatch(r"v\d+", v):
    sys.exit("Kullanım: python scripts/surum.py v6")
app = root / "app.js"
app.write_text(re.sub(r'const VERSION = "v\d+";', f'const VERSION = "{v}";', app.read_text("utf-8"), count=1), "utf-8")
ix = root / "index.html"
t = ix.read_text("utf-8")
t = re.sub(r'window\.BUILD = "v\d+";', f'window.BUILD = "{v}";', t, count=1)
t = re.sub(r'(style\.css|app\.js)\?v=v\d+', lambda m: f"{m.group(1)}?v={v}", t)
ix.write_text(t, "utf-8")
(root / "version.json").write_text(f'{{"v": "{v}"}}\n', "utf-8")
print("Sürüm", v, "oldu.")

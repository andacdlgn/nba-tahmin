"""Sürüm numarasını her yerde birden günceller.

Biçim: 1.ÖZELLİK.DÜZELTME  (1 = 2026-27 sezonu)
  python scripts/surum.py 1.2.0     doğrudan yaz
  python scripts/surum.py ozellik   1.1.3 -> 1.2.0  (yeni özellik paketi; app.js'teki CHANGELOG'a da ekle)
  python scripts/surum.py duzeltme  1.1.3 -> 1.1.4  (hata düzeltmesi)
Değişenler: app.js VERSION, index.html BUILD ve ?v= numaraları, version.json.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

root = Path(__file__).resolve().parent.parent

from csp import csp  # noqa: E402  (satır içi betik özetleri; ayrıntı scripts/csp.py)
app = root / "app.js"
# app.js tarayıcıda modül olarak yüklenir: modül olarak sözdizimi hatası varsa sürüm atlanmasın (site açılmaz)
import shutil, subprocess, tempfile
if shutil.which("node"):
    with tempfile.TemporaryDirectory() as d:
        t = Path(d) / "app.mjs"; t.write_text(app.read_text("utf-8"), "utf-8")
        r = subprocess.run(["node", "--check", str(t)], capture_output=True, text=True)
        if r.returncode:
            sys.exit("app.js modül olarak açılmıyor, sürüm değişmedi:\n" + (r.stderr or r.stdout)[-600:])
src = app.read_text("utf-8")
cur = re.search(r'const VERSION = "([^"]+)";', src).group(1)
arg = sys.argv[1] if len(sys.argv) > 1 else ""
m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", cur)
if re.fullmatch(r"\d+\.\d+\.\d+", arg):
    v = arg
elif arg in ("ozellik", "duzeltme") and m:
    a, b, c = map(int, m.groups())
    v = f"{a}.{b + 1}.0" if arg == "ozellik" else f"{a}.{b}.{c + 1}"
else:
    sys.exit("Kullanım: python scripts/surum.py 1.2.0 | ozellik | duzeltme")
app.write_text(src.replace(f'const VERSION = "{cur}";', f'const VERSION = "{v}";', 1), "utf-8")
ix = root / "index.html"
t = ix.read_text("utf-8")
t = re.sub(r'window\.BUILD = "[^"]+";', f'window.BUILD = "{v}";', t, count=1)
t = re.sub(r'(style\.css|app\.js)\?v=[0-9A-Za-z.]+', lambda mm: f"{mm.group(1)}?v={v}", t)
t = csp(t)
ix.write_text(t, "utf-8")
(root / "version.json").write_text(f'{{"v": "{v}"}}\n', "utf-8")
print("Sürüm", v, "oldu.")

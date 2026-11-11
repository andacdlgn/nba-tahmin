"""index.html'deki satır içi <script>'lerin sha256 özetlerini Content-Security-Policy'ye yazar.
surum.py ve sitecheck.py ortak kullanır."""
import re
# Tarayıcı koruması (Content-Security-Policy). index.html'deki satır içi <script>'lerin sha256 özetleri
# her sürümde yeniden hesaplanır (BUILD numarası değişince özet de değişir). Yeni bir dış adres eklenirse buraya yaz.
import base64, hashlib
CSP = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "https://www.gstatic.com/firebasejs/", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:", "https://a.espncdn.com"],
    "connect-src": ["'self'", "https://firestore.googleapis.com", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com",
                    "https://content-firebaseappcheck.googleapis.com", "https://www.google.com", "https://site.web.api.espn.com", "https://site.api.espn.com",
                    "https://a.espncdn.com", "https://raw.githubusercontent.com", "https://www.gstatic.com", "http://127.0.0.1:9099", "http://127.0.0.1:8085"],
    "frame-src": ["https://nba-tahmin.firebaseapp.com", "https://www.google.com/recaptcha/", "https://recaptcha.google.com/recaptcha/"],
    "worker-src": ["'self'"], "manifest-src": ["'self'"], "object-src": ["'none'"], "base-uri": ["'self'"], "form-action": ["'self'"],
}
def csp(html):
    pol = {k: list(v) for k, v in CSP.items()}
    for body in re.findall(r"<script>(.*?)</script>", html, flags=re.S):
        pol["script-src"].append("'sha256-" + base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode() + "'")
    val = "; ".join(f"{k} {' '.join(v)}" for k, v in pol.items())
    return re.sub(r'(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)', lambda m: m.group(1) + val + m.group(2), html, count=1)

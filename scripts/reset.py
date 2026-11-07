"""Şifre sıfırlama isteklerini işler (GitHub Actions, birkaç dakikada bir).

Akış:
  1. Site, "Şifremi unuttum" formundan resets/{id} belgesi oluşturur:
     {name, team, playerId, pin (yeni şifre), at}. Bu belgeyi kimse okuyamaz.
  2. Bu betik yönetici yetkisiyle istekleri okur, oyuncunun güvenlik cevabının
     (recovery/{uid}: tuzlu SHA-256) eşleşip eşleşmediğine bakar.
  3. Eşleşirse Firebase Auth'taki şifreyi değiştirir. Sonucu resetStatus/{id}
     belgesine yazar ve isteği siler.
  4. Üç yanlış denemeden sonra o oyuncu için 1 saat bekleme konur (resetLocks/{uid}).

Mail ile sıfırlama:
  a. Site mailReset/{id} = {name, at} yazar. Bu betik oyuncunun onaylı mail adresine 6 haneli kod yollar,
     resetCode/{uid} = {salt, h, exp} (kimse okuyamaz) saklar, resetStatus/{id} = {state: sent, m: maskeli adres} yazar.
  b. Site kodu ve yeni şifreyi resets/{id} = {name, code, pin, at} olarak yollar; kod tutarsa şifre değişir.

Gerekli gizli değişken: FIREBASE_SA (Firebase hizmet hesabı anahtarının JSON içeriği).
"""
import hashlib
import hmac
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import auth, credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
MAX_FAILS = 3
# Güvenlik (1.30.2): sitedeki weakPin ile aynı liste; sıfırlamada kolay PIN sunucuda da reddedilir
WEAK_PINS = {"123456", "654321", "012345", "543210", "123123", "121212", "112233", "098765", "987654", "456789", "147258", "159753"}


def weak_pin(p: str) -> bool:
    return bool(re.fullmatch(r"(\d)\1{5}", p) or re.fullmatch(r"(\d\d)\1\1", p) or re.fullmatch(r"(\d{3})\1", p)) or p in WEAK_PINS
LOCK = timedelta(hours=1)


def slug(s: str) -> str:
    # sitedeki slug() ile birebir aynı olmalı (Türkçe küçük harf + ç/ğ/ı/ö/ş/ü dönüşümü)
    s = s.replace("I", "ı").replace("İ", "i").lower()
    s = s.translate(str.maketrans("çğıöşü", "cgiosu"))
    return re.sub(r"[^a-z0-9]", "", s)


NAME_BAD = re.compile(r"(orospu|orosbu|siktir|sikerim|sikeyim|sikik|yarrak|dalyarak|am[iı]nak|amc[iı]k|ibne|pezevenk|kahpe|kaltak|yav[sş]ak|[sş]erefsiz|fuck|shit|bitch|cunt|nigg|faggot|whore|asshole)")


def name_ok(n: str) -> bool:
    """firestore.rules validName ile aynı: büyük harfle başlar, harf/rakam/boşluk/. ' - içerir, en fazla 40 karakter, küfür yok."""
    if not n or len(n) > 40 or not n[0].isupper() or not n[0].isalpha():
        return False
    if any(not (c.isalpha() or c.isdigit() or c in " .'-") for c in n):
        return False
    return not NAME_BAD.search(n.replace("I", "ı").replace("İ", "i").lower())


def run_rename(db):
    """renameReq/{uid} = {name}: oyuncunun görünen adını ve giriş adını (Firebase hesabının e-postası) birlikte değiştirir.
    Sonuç renameRes/{uid} = {state: ok|error, msg, name}."""
    reqs = list(db.collection("renameReq").stream())
    if not reqs:
        return
    players = {d.id: (d.to_dict() or {}) for d in db.collection("players").stream()}
    for r in reqs:
        uid, new = r.id, str((r.to_dict() or {}).get("name") or "").strip()
        res = db.collection("renameRes").document(uid)

        def finish(state, msg=""):
            res.set({"state": state, "msg": msg, "name": new, "at": firestore.SERVER_TIMESTAMP})
            r.reference.delete()

        if uid not in players:
            r.reference.delete()
            continue
        if not name_ok(new) or not slug(new):
            finish("error", "Bu ad uygun değil: büyük harfle başlamalı; yalnızca harf, rakam, boşluk ve . - ' olabilir.")
            continue
        s = slug(new)
        if any(slug(p.get("name", "")) == s for u, p in players.items() if u != uid):
            finish("error", "Bu ad alınmış. Soyadının baş harfini ekleyebilirsin (ör. Ali K.).")
            continue
        email = f"{s}@{CONFIG['authEmailDomain']}"
        try:
            other = auth.get_user_by_email(email)
            if other.uid != uid:
                finish("error", "Bu ad alınmış. Soyadının baş harfini ekleyebilirsin (ör. Ali K.).")
                continue
        except auth.UserNotFoundError:
            pass
        try:
            auth.update_user(uid, email=email)
            db.collection("players").document(uid).update({"name": new})
            players[uid]["name"] = new
            finish("ok")
            print("ad değişti:", uid[:5])
        except Exception as e:
            finish("error", "Ad değiştirilemedi, biraz sonra tekrar dene.")
            print("ad değiştirme hatası:", type(e).__name__)


def answer_hash(salt: str, team: str, player_id: str) -> str:
    return hashlib.sha256(f"{salt}{team}:{player_id}".encode("utf-8")).hexdigest()


def _due(name, secs):
    """Arka plan döngüsü aynı makinede çalışır: son çalışma zamanı geçici dosyada tutulur."""
    import tempfile, time as _t
    f = os.path.join(tempfile.gettempdir(), f"nbat_{name}")
    try:
        if _t.time() - os.path.getmtime(f) < secs:
            return False
    except OSError:
        pass
    open(f, "w").close()
    return True


def clean_orphans(db):
    keep = {d.id for d in db.collection("players").stream()}
    keep |= {d.id for d in db.collection("banned").stream()}   # ligden çıkarılan aynı adla yeniden kayıt olamasın
    adm = db.collection("config").document("admin").get().to_dict() or {}
    keep |= set(adm.get("uids") or [])
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).timestamp() * 1000
    gone = 0
    for u in auth.list_users().iterate_all():
        if u.uid in keep or (u.user_metadata.creation_timestamp or 0) > cutoff:
            continue
        auth.delete_user(u.uid)
        gone += 1
    if gone:
        print(f"{gone} sahipsiz giriş hesabı silindi")


def main():
    sa = os.environ.get("FIREBASE_SA", "").strip()
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):  # yerel test
        from google.auth.credentials import AnonymousCredentials

        class _Anon(credentials.Base):
            def get_credential(self):
                return AnonymousCredentials()

        firebase_admin.initialize_app(_Anon(), options={"projectId": os.environ.get("GCLOUD_PROJECT", "demo-tahmin")})
    elif not sa:
        print("FIREBASE_SA gizli değişkeni yok; sıfırlama devre dışı.")
        return 0
    else:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(sa)))
    db = firestore.client()
    now = datetime.now(timezone.utc)

    for r in db.collection("mailReset").stream():
        state, extra = "error", {}
        try:
            state, extra = send_code(db, r.to_dict() or {}, now)
        except Exception as e:
            print("hata:", r.id, type(e).__name__)
        db.collection("resetStatus").document(r.id).set({"state": state, "at": firestore.SERVER_TIMESTAMP, **extra})
        r.reference.delete()
        print("kod", r.id[:6], state)

    reqs = list(db.collection("resets").stream())
    print(f"{len(reqs)} istek")
    for r in reqs:
        d = r.to_dict() or {}
        state = "error"
        try:
            state = handle(db, d, now)
        except Exception as e:  # tek istek bozuksa diğerleri işlensin
            print("hata:", r.id, type(e).__name__)
        db.collection("resetStatus").document(r.id).set({"state": state, "at": firestore.SERVER_TIMESTAMP})
        r.reference.delete()
        print(r.id[:6], state)

    # Aşağıdakiler acil değil: Firestore okuma kotası için her 20 saniyede değil, 2 dakikada bir çalışır
    if not _due("reset_full", 60):
        return 0

    # oyuncunun ad değiştirme isteği (varsa)
    try:
        run_rename(db)
    except Exception as e:
        print("ad değiştirme görevi hatası:", type(e).__name__)

    # Güvenlik (1.30.2): davet kodu doğrulanmadan açılıp ligde oyuncu kaydı hiç oluşmamış giriş hesapları
    # 1 saat sonra silinir (böylece biri gerçek bir oyuncunun adını önceden kapıp tutamaz). Saatte bir bakılır.
    if _due("orphans", 3600):
        try:
            clean_orphans(db)
        except Exception as e:
            print("sahipsiz hesap temizliği hatası:", type(e).__name__)

    # yönetim panelindeki "Herkesi sil" isteği (varsa)
    try:
        import purge
        purge.run(db)
    except Exception as e:
        print("silme görevi hatası:", type(e).__name__)

    # bir günden eski sonuç kayıtlarını temizle
    old = now - timedelta(days=1)
    for s in db.collection("resetStatus").where(filter=FieldFilter("at", "<", old)).stream():
        s.reference.delete()
    return 0


def mask(email):
    user, _, dom = email.partition("@")
    return (user[:2] + "•" * max(1, len(user) - 2)) + "@" + dom


def send_code(db, d, now):
    """Onaylı mail adresine sıfırlama kodu yollar."""
    import secrets
    from html import escape
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from remind import Mailer, build, card  # noqa: E402

    name = str(d.get("name", ""))
    if not slug(name):
        return "error", {}
    try:
        user = auth.get_user_by_email(f"{slug(name)}@{CONFIG['authEmailDomain']}")
    except auth.UserNotFoundError:
        return "nouser", {}
    uid = user.uid
    # Güvenlik (1.30.1): kod yolu kendi kilidine bakar; güvenlik sorusunu yanlış deneyen biri mail yolunu kilitleyemez
    lock = (db.collection("resetLocks").document(uid).get().to_dict() or {})
    if lock.get("cuntil") and lock["cuntil"] > now:
        return "locked", {}
    c = db.collection("contacts").document(uid).get().to_dict() or {}
    email = (c.get("email") or "").strip()
    if not c.get("verified") or "@" not in email:
        return "nomail", {}
    old = db.collection("resetCode").document(uid).get().to_dict() or {}
    if old.get("sentAt") and now - old["sentAt"] < timedelta(minutes=2):
        return "wait", {}
    # Güvenlik (1.30.1): başkası adına sürekli kod maili attırılamasın; bir oyuncuya günde en fazla 3 kod
    today = now.strftime("%Y%m%d")
    sent_today = int(old.get("n", 0)) if old.get("day") == today else 0
    if sent_today >= 3:
        return "wait", {}
    mail = Mailer("--dry" in sys.argv)
    if not mail.ok():
        return "error", {}
    pname = name[:1].upper() + name[1:]
    code = f"{secrets.randbelow(10**6):06d}"
    salt = secrets.token_hex(16)
    inner = (f'<p style="margin:0 0 10px">Selam {escape(pname)}, şifreni sıfırlamak için bu kodu sitedeki "Şifremi unuttum" ekranına yaz:</p>'
             f'<p style="margin:0 0 14px;font-size:34px;font-weight:bold;letter-spacing:8px;font-family:monospace">{code}</p>'
             '<p style="margin:0 0 12px;color:#5f6b78;font-size:14px">Kod 3 saat geçerli. Bu isteği sen yapmadıysan bu maili yok say; şifren değişmez.</p>')
    msg = build(email, f"NBA Tahmin şifre sıfırlama kodun: {code}",
                f"Selam {pname},\n\nŞifre sıfırlama kodun: {code}\nKod 3 saat geçerli. Bu isteği sen yapmadıysan bu maili yok say; şifren değişmez.",
                card("Şifre sıfırlama kodu", "Şifremi unuttum", inner, "Siteye git", pre=f"Kodun: {code}"), pname, "sifre")
    if not mail.send(msg):
        mail.close()
        return "error", {}
    mail.close()
    db.collection("resetCode").document(uid).set({"salt": salt, "h": hashlib.sha256((salt + code).encode()).hexdigest(),
                                                  "exp": now + timedelta(hours=3), "sentAt": now,
                                                  "day": today, "n": sent_today + 1})
    return "sent", {"m": mask(email)}


def handle(db, d, now):
    name, team, pid, pin, code = (str(d.get(k, "")) for k in ("name", "team", "playerId", "pin", "code"))
    if not re.fullmatch(r"[0-9]{6}", pin) or not slug(name):
        return "error"
    if weak_pin(pin):
        return "weak"
    try:
        user = auth.get_user_by_email(f"{slug(name)}@{CONFIG['authEmailDomain']}")
    except auth.UserNotFoundError:
        return "nouser"
    uid = user.uid

    # Güvenlik (1.30.1): güvenlik sorusu ve mail kodu ayrı sayılır ve ayrı kilitlenir. Böylece adını bilen biri
    # 3 yanlış soru cevabıyla sahibinin mail koduyla sıfırlamasını engelleyemez.
    lock_ref = db.collection("resetLocks").document(uid)
    lock = (lock_ref.get().to_dict() or {})
    fk, uk = ("cfails", "cuntil") if code else ("fails", "until")
    until = lock.get(uk)
    if until and until > now:
        return "locked"

    if code:   # maile gelen kodla
        cref = db.collection("resetCode").document(uid)
        rc = cref.get().to_dict() or {}
        if not rc.get("h"):
            return "expired"
        if rc.get("exp") and rc["exp"] < now:
            cref.delete()
            return "expired"
        if hmac.compare_digest(hashlib.sha256((rc["salt"] + code).encode()).hexdigest(), rc["h"]):
            auth.update_user(uid, password=pin)
            lock_ref.delete()
            cref.delete()
            return "ok"
        wrong = "badcode"
    else:
        rec = db.collection("recovery").document(uid).get().to_dict()
        if not rec or "salt" not in rec or "h" not in rec:
            return "nosetup"
        if hmac.compare_digest(answer_hash(rec["salt"], team, pid), rec["h"]):
            auth.update_user(uid, password=pin)
            lock_ref.delete()
            return "ok"
        wrong = "wrong"

    fails = int(lock.get(fk, 0)) + 1
    if fails >= MAX_FAILS:
        lock_ref.set({fk: 0, uk: now + LOCK}, merge=True)
        if code:   # kod tahmin edilmeye çalışılıyor: o kodu geçersiz yap, yenisi istenmeli
            db.collection("resetCode").document(uid).delete()
        return "locked"
    lock_ref.set({fk: fails, uk: None}, merge=True)
    return wrong


if __name__ == "__main__":
    sys.exit(main())

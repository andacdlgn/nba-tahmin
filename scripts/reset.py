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
LOCK = timedelta(hours=1)


def slug(s: str) -> str:
    # sitedeki slug() ile birebir aynı olmalı (Türkçe küçük harf + ç/ğ/ı/ö/ş/ü dönüşümü)
    s = s.replace("I", "ı").replace("İ", "i").lower()
    s = s.translate(str.maketrans("çğıöşü", "cgiosu"))
    return re.sub(r"[^a-z0-9]", "", s)


def answer_hash(salt: str, team: str, player_id: str) -> str:
    return hashlib.sha256(f"{salt}{team}:{player_id}".encode("utf-8")).hexdigest()


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
    lock = (db.collection("resetLocks").document(uid).get().to_dict() or {})
    if lock.get("until") and lock["until"] > now:
        return "locked", {}
    c = db.collection("contacts").document(uid).get().to_dict() or {}
    email = (c.get("email") or "").strip()
    if not c.get("verified") or "@" not in email:
        return "nomail", {}
    old = db.collection("resetCode").document(uid).get().to_dict() or {}
    if old.get("sentAt") and now - old["sentAt"] < timedelta(minutes=2):
        return "wait", {}
    mail = Mailer("--dry" in sys.argv)
    if not mail.ok():
        return "error", {}
    pname = name[:1].upper() + name[1:]
    code = f"{secrets.randbelow(10**6):06d}"
    salt = secrets.token_hex(16)
    inner = (f'<p style="margin:0 0 10px">Selam {escape(pname)}, şifreni sıfırlamak için bu kodu sitedeki "Şifremi unuttum" ekranına yaz:</p>'
             f'<p style="margin:0 0 14px;font-size:34px;font-weight:bold;letter-spacing:8px;font-family:monospace">{code}</p>'
             '<p style="margin:0 0 12px;color:#5f6b78;font-size:14px">Kod 30 dakika geçerli. Bu isteği sen yapmadıysan bu maili yok say; şifren değişmez.</p>')
    msg = build(email, f"NBA Tahmin şifre sıfırlama kodun: {code}",
                f"Selam {pname},\n\nŞifre sıfırlama kodun: {code}\nKod 30 dakika geçerli. Bu isteği sen yapmadıysan bu maili yok say; şifren değişmez.",
                card("Şifre sıfırlama kodu", "Şifremi unuttum", inner, "Siteye git", pre=f"Kodun: {code}"), pname, "sifre")
    if not mail.send(msg):
        mail.close()
        return "error", {}
    mail.close()
    db.collection("resetCode").document(uid).set({"salt": salt, "h": hashlib.sha256((salt + code).encode()).hexdigest(),
                                                  "exp": now + timedelta(minutes=30), "sentAt": now})
    return "sent", {"m": mask(email)}


def handle(db, d, now):
    name, team, pid, pin, code = (str(d.get(k, "")) for k in ("name", "team", "playerId", "pin", "code"))
    if not re.fullmatch(r"[0-9]{6}", pin) or not slug(name):
        return "error"
    try:
        user = auth.get_user_by_email(f"{slug(name)}@{CONFIG['authEmailDomain']}")
    except auth.UserNotFoundError:
        return "nouser"
    uid = user.uid

    lock_ref = db.collection("resetLocks").document(uid)
    lock = (lock_ref.get().to_dict() or {})
    until = lock.get("until")
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

    fails = int(lock.get("fails", 0)) + 1
    if fails >= MAX_FAILS:
        lock_ref.set({"fails": 0, "until": now + LOCK})
        return "locked"
    lock_ref.set({"fails": fails, "until": None})
    return wrong


if __name__ == "__main__":
    sys.exit(main())

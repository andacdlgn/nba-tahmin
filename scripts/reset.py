"""Şifre sıfırlama isteklerini işler (GitHub Actions, birkaç dakikada bir).

Akış:
  1. Site, "Şifremi unuttum" formundan resets/{id} belgesi oluşturur:
     {name, team, playerId, pin (yeni şifre), at}. Bu belgeyi kimse okuyamaz.
  2. Bu betik yönetici yetkisiyle istekleri okur, oyuncunun güvenlik cevabının
     (recovery/{uid}: tuzlu SHA-256) eşleşip eşleşmediğine bakar.
  3. Eşleşirse Firebase Auth'taki şifreyi değiştirir. Sonucu resetStatus/{id}
     belgesine yazar ve isteği siler.
  4. Üç yanlış denemeden sonra o oyuncu için 1 saat bekleme konur (resetLocks/{uid}).

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


def handle(db, d, now):
    name, team, pid, pin = (str(d.get(k, "")) for k in ("name", "team", "playerId", "pin"))
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

    rec = db.collection("recovery").document(uid).get().to_dict()
    if not rec or "salt" not in rec or "h" not in rec:
        return "nosetup"

    if hmac.compare_digest(answer_hash(rec["salt"], team, pid), rec["h"]):
        auth.update_user(uid, password=pin)
        lock_ref.delete()
        return "ok"

    fails = int(lock.get("fails", 0)) + 1
    if fails >= MAX_FAILS:
        lock_ref.set({"fails": 0, "until": now + LOCK})
        return "locked"
    lock_ref.set({"fails": fails, "until": None})
    return "wrong"


if __name__ == "__main__":
    sys.exit(main())

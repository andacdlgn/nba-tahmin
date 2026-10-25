"""E-posta onay kodu (OTP) gönderir. GitHub Actions'ta şifre sıfırlamayla birlikte 5 dakikada bir çalışır.

Akış:
  1. Site, profilde "Kod gönder"e basınca verifyReq/{uid} = {email, at} yazar.
  2. Bu betik 6 haneli bir kod üretir, otp/{uid} = {email, salt, h (sha256(salt+kod), bytes), exp} yazar
     (kimse okuyamaz) ve kodu o adrese mailler. otpStatus/{uid} = {email, sentAt, exp} sahibine görünür.
  3. Oyuncu kodu sitede girer; Firebase kuralı kodu otp/{uid} ile karşılaştırır ve doğruysa
     contacts/{uid}.verified = true olur. Hatırlatma mailleri yalnızca onaylı adreslere gider.

Gizli değişkenler: FIREBASE_SA, GMAIL_USER, GMAIL_APP_PASSWORD
"""
import hashlib
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from html import escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from remind import Mailer, build, card, firestore, init  # noqa: E402

VALID = timedelta(minutes=30)


def main():
    dry = "--dry" in sys.argv
    db = init()
    if db is None:
        print("FIREBASE_SA yok; onay kodu devre dışı.")
        return 0
    mail = Mailer(dry)
    if not mail.ok():
        print("GMAIL_USER / GMAIL_APP_PASSWORD yok; kod gönderilmiyor.")
        return 0
    now = datetime.now(timezone.utc)
    reqs = list(db.collection("verifyReq").stream())
    print(f"{len(reqs)} onay isteği")
    for r in reqs:
        uid, d = r.id, r.to_dict() or {}
        email = (d.get("email") or "").strip()
        r.reference.delete()
        if "@" not in email or len(email) > 120:
            continue
        p = db.collection("players").document(uid).get()
        if not p.exists:
            continue
        # aynı kişi art arda basarsa 2 dakikada bir koddan fazla gönderme
        st = db.collection("otpStatus").document(uid).get()
        if st.exists and (st.to_dict() or {}).get("email") == email and (st.to_dict() or {}).get("sentAt") and now - st.to_dict()["sentAt"] < timedelta(minutes=2):
            continue
        name = (p.to_dict() or {}).get("name", "")
        name = name[:1].upper() + name[1:]
        code = f"{secrets.randbelow(10**6):06d}"
        salt = secrets.token_hex(16)
        h = hashlib.sha256((salt + code).encode("utf-8")).digest()
        inner = (f'<p style="margin:0 0 10px">Selam {escape(name)}, e-posta adresini onaylamak için bu kodu sitede profiline yaz:</p>'
                 f'<p style="margin:0 0 14px;font-size:34px;font-weight:bold;letter-spacing:8px;font-family:monospace">{code}</p>'
                 '<p style="margin:0 0 12px;color:#5f6b78;font-size:14px">Kod 30 dakika geçerli. Bu isteği sen yapmadıysan bu maili yok sayabilirsin.</p>')
        msg = build(email, f"NBA Tahmin onay kodun: {code}",
                    f"Selam {name},\n\nE-posta onay kodun: {code}\nKod 30 dakika geçerli. Bu isteği sen yapmadıysan bu maili yok sayabilirsin.",
                    card("E-posta onay kodu", "Profil", inner, "Siteye git"))
        if dry:
            print("[deneme] kod:", code)
        if not mail.send(msg):
            continue
        db.collection("otp").document(uid).set({"email": email, "salt": salt, "h": h, "exp": now + VALID})
        db.collection("otpStatus").document(uid).set({"email": email, "sentAt": now, "exp": now + VALID})
    mail.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

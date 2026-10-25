"""Tahmin girmeyenlere hatırlatma maili (GitHub Actions, 10 dakikada bir).

Gecenin ilk maçından (kilit) yaklaşık 2 saat önce, profilinde e-posta adresi kayıtlı ve
hatırlatmayı açık bırakmış oyunculardan eksik tahmini olanlara bir kez mail atar.

Okunanlar (yönetici yetkisiyle):
  players/{uid}           ad
  contacts/{uid}          {email, remind}   (yalnızca sahibi ve bu betik okur)
  picks/{maç}_{uid}       tahmin var mı
  daily/{gün}_{uid}       banko / günün oyuncusu seçilmiş mi
Yazılan:
  reminders/{gün}_{uid}   aynı gece ikinci kez mail gitmesin

Gizli değişkenler: FIREBASE_SA, GMAIL_USER, GMAIL_APP_PASSWORD
Deneme: python scripts/remind.py --dry   (mail atmaz, ne atacağını yazar)
        python scripts/remind.py --now   (2 saat penceresini beklemeden çalışır)
"""
import json
import os
import smtplib
import ssl
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
from html import escape
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import credentials, firestore

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sync import CONFIG, espn_today, scoreboard  # noqa: E402

TR = ZoneInfo("Europe/Istanbul")
BEFORE = timedelta(minutes=int(CONFIG.get("remindBeforeMinutes", 120)))
SITE = CONFIG.get("siteUrl", "")


def init():
    sa = os.environ.get("FIREBASE_SA", "").strip()
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):  # yerel test
        from google.auth.credentials import AnonymousCredentials

        class _Anon(credentials.Base):
            def get_credential(self):
                return AnonymousCredentials()

        firebase_admin.initialize_app(_Anon(), options={"projectId": os.environ.get("GCLOUD_PROJECT", "demo-tahmin")})
    elif sa:
        firebase_admin.initialize_app(credentials.Certificate(json.loads(sa)))
    else:
        return None
    return firestore.client()


def night_games(day):
    out = []
    for ev in scoreboard(day):
        if ev.get("season", {}).get("type") == 1:  # hazırlık maçları sayılmaz
            continue
        c = ev["competitions"][0]["competitors"]
        side = {x["homeAway"]: x["team"] for x in c}
        out.append({"id": ev["id"], "start": datetime.fromisoformat(ev["date"].replace("Z", "+00:00")),
                    "away": side["away"].get("shortDisplayName", side["away"]["abbreviation"]),
                    "home": side["home"].get("shortDisplayName", side["home"]["abbreviation"]),
                    "state": ev["status"]["type"]["state"]})
    return sorted(out, key=lambda g: g["start"])


def message(name, email, day_nice, lock_tr, missing, no_banko, no_dp, total):
    left = len(missing)
    parts = []
    if left:
        parts.append(f"{left} maçın tahmini eksik" if left < total else "bu gecenin hiçbir maçına tahmin girmedin")
    if no_banko:
        parts.append("banko seçilmedi")
    if no_dp:
        parts.append("günün oyuncusu seçilmedi")
    subject = f"🏀 Kilit {lock_tr}'de: " + ", ".join(parts)
    rows = "".join(f"<li>{escape(g['away'])} @ {escape(g['home'])}</li>" for g in missing[:15])
    text = (f"Selam {name},\n\n{day_nice} gecesi için {', '.join(parts)}.\n"
            f"Bütün tahminler gecenin ilk maçı başlayınca, {lock_tr}'de (Türkiye saati) kilitlenir.\n\n"
            + ("Eksik maçlar:\n" + "\n".join(f"- {g['away']} @ {g['home']}" for g in missing[:15]) + "\n\n" if missing else "")
            + f"Tahmin yap: {SITE}\n\nHatırlatma istemiyorsan sitede profilinden kapatabilirsin.\n")
    html = f"""<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#121a24">
  <div style="background:#121a24;color:#f4f6f8;border-radius:14px 14px 0 0;padding:18px 20px;border-bottom:4px solid #e09410">
    <div style="font-size:13px;color:#8b98a8">NBA Tahmin · {escape(day_nice)}</div>
    <div style="font-size:22px;font-weight:bold;margin-top:4px">Kilit {escape(lock_tr)}'de</div></div>
  <div style="border:1px solid #dde3e9;border-top:0;border-radius:0 0 14px 14px;padding:18px 20px">
    <p style="margin:0 0 10px">Selam {escape(name)}, {escape(', '.join(parts))}.</p>
    <p style="margin:0 0 12px;color:#5f6b78;font-size:14px">Bütün tahminler gecenin ilk maçı başlayınca kilitlenir (Türkiye saati {escape(lock_tr)}).</p>
    {f'<ul style="margin:0 0 14px;padding-left:20px;font-size:14px">{rows}</ul>' if rows else ''}
    <a href="{escape(SITE)}" style="display:inline-block;background:#121a24;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">Tahmin yap</a>
    <p style="margin:16px 0 0;color:#8b98a8;font-size:12px">Hatırlatma istemiyorsan sitede profilinden kapatabilirsin.</p></div></div>"""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["To"] = email
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    return msg


def main():
    dry = "--dry" in sys.argv
    force = "--now" in sys.argv
    db = init()
    if db is None:
        print("FIREBASE_SA yok; hatırlatma devre dışı.")
        return 0
    user, pw = os.environ.get("GMAIL_USER", "").strip(), os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not dry and not (user and pw):
        print("GMAIL_USER / GMAIL_APP_PASSWORD yok; mail gönderilmiyor.")
        return 0

    day = espn_today().strftime("%Y%m%d")
    games = night_games(day)
    if not games:
        print(day, "maç yok")
        return 0
    lock = games[0]["start"]
    now = datetime.now(timezone.utc)
    if not force and not (lock - BEFORE <= now < lock):
        print(f"{day}: kilit {lock:%H:%MZ}, pencere dışında ({(lock - now).total_seconds() / 60:.0f} dk var)")
        return 0
    lock_tr = lock.astimezone(TR).strftime("%H:%M")
    months = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
    day_nice = f"{int(day[6:])} {months[int(day[4:6]) - 1]}"  # ESPN (ABD) tarihi, sitedeki gibi

    smtp = None
    sent = 0
    for c in db.collection("contacts").stream():
        uid, info = c.id, c.to_dict() or {}
        email = (info.get("email") or "").strip()
        if not info.get("remind") or "@" not in email:
            continue
        rref = db.collection("reminders").document(f"{day}_{uid}")
        if rref.get().exists:
            continue
        p = db.collection("players").document(uid).get()
        if not p.exists:
            continue
        name = (p.to_dict() or {}).get("name", "")
        name = name[:1].upper() + name[1:]
        refs = [db.collection("picks").document(f"{g['id']}_{uid}") for g in games]
        have = {s.id.split("_")[0] for s in db.get_all(refs) if s.exists}
        missing = [g for g in games if g["id"] not in have]
        daily = db.collection("daily").document(f"{day}_{uid}").get()
        d = daily.to_dict() if daily.exists else {}
        no_banko, no_dp = not d.get("confGame"), not d.get("dayPlayerId")
        if not missing and not no_banko and not no_dp:
            continue
        msg = message(name, email, day_nice, lock_tr, missing, no_banko, no_dp, len(games))
        msg["From"] = formataddr(("NBA Tahmin", user or "test@example.com"))
        if dry:
            print("[deneme]", name, "->", email, "|", msg["Subject"])
            continue
        try:
            if smtp is None:
                host, port = os.environ.get("SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("SMTP_PORT", "465"))
                if os.environ.get("SMTP_PLAIN"):  # yerel test sunucusu
                    smtp = smtplib.SMTP(host, port, timeout=30)
                else:
                    smtp = smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=30)
                    smtp.login(user, pw)
            smtp.send_message(msg)
        except Exception as e:  # tek adres sorunluysa diğerlerine devam
            print("gönderilemedi:", uid[:6], type(e).__name__)
            continue
        rref.set({"at": firestore.SERVER_TIMESTAMP, "missing": len(missing)})
        sent += 1
        print("gönderildi:", uid[:6], msg["Subject"])
    if smtp:
        smtp.quit()
    print(f"{day}: {sent} mail")
    return 0


if __name__ == "__main__":
    sys.exit(main())

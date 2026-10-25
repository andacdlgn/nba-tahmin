"""Mailler (GitHub Actions, 10 dakikada bir):

1. Hatırlatma: gecenin ilk maçından (kilit) yaklaşık 2 saat önce, eksik tahmini olanlara bir kez.
2. Sakatlık uyarısı: skorer ya da günün oyuncusu olarak seçilen oyuncu ESPN'de "Out" görünürse, kilitten önce.
3. Haftalık özet: pazartesi 10:00'dan (Türkiye) sonra, geçen haftanın sonuçları (data/scores.json).

Hatırlatma ve sakatlık uyarısı "remind", haftalık özet "weekly" tercihi açık olanlara gider.

Okunanlar (yönetici yetkisiyle):
  players/{uid}           ad
  contacts/{uid}          {email, remind}   (yalnızca sahibi ve bu betik okur)
  picks/{maç}_{uid}       tahmin var mı
  daily/{gün}_{uid}       banko / günün oyuncusu seçilmiş mi
Yazılan:
  reminders/{...}         aynı mail ikinci kez gitmesin

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
from email.utils import formataddr, formatdate, make_msgid
from html import escape
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import credentials, firestore

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sync import CONFIG, ESPN, espn_today, get, load, scoreboard, week_key  # noqa: E402

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
                    "teams": [x["team"]["id"] for x in c],
                    "away": side["away"].get("shortDisplayName", side["away"]["abbreviation"]),
                    "home": side["home"].get("shortDisplayName", side["home"]["abbreviation"]),
                    "state": ev["status"]["type"]["state"]})
    return sorted(out, key=lambda g: g["start"])


MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
nice = lambda d: f"{int(d[6:])} {MONTHS[int(d[4:6]) - 1]}"  # ESPN (ABD) tarihi, sitedeki gibi


def card(title, sub, inner, button="Siteye git"):
    """Bütün mailler için ortak görünüm."""
    return f"""<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#121a24">
  <div style="background:#121a24;color:#f4f6f8;border-radius:14px 14px 0 0;padding:18px 20px;border-bottom:4px solid #e09410">
    <div style="font-size:13px;color:#8b98a8">NBA Tahmin · {escape(sub)}</div>
    <div style="font-size:22px;font-weight:bold;margin-top:4px">{escape(title)}</div></div>
  <div style="border:1px solid #dde3e9;border-top:0;border-radius:0 0 14px 14px;padding:18px 20px">{inner}
    <a href="{escape(SITE)}" style="display:inline-block;margin-top:6px;background:#121a24;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">{escape(button)}</a>
    <p style="margin:16px 0 0;color:#8b98a8;font-size:12px">Bu mailleri istemiyorsan sitede profilinden kapatabilirsin.</p></div></div>"""


def build(email, subject, text, html):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["To"] = email
    msg.set_content(text + f"\n\n{SITE}\n\nBu mailleri istemiyorsan sitede profilinden kapatabilirsin.\n")
    msg.add_alternative(html, subtype="html")
    return msg


class Mailer:
    def __init__(self, dry):
        self.dry, self.smtp, self.sent = dry, None, 0
        self.user = os.environ.get("GMAIL_USER", "").strip()
        self.pw = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")

    def ok(self):
        return self.dry or (self.user and self.pw)

    def send(self, msg):
        msg["From"] = formataddr(("NBA Tahmin", self.user or "test@example.com"))
        # Spam filtreleri eksik başlıklara takılmasın diye tarih, kimlik ve abonelikten çıkma bilgisi
        if not msg["Date"]:
            msg["Date"] = formatdate(localtime=False)
        if not msg["Message-ID"]:
            msg["Message-ID"] = make_msgid(domain=(self.user.split("@")[-1] if "@" in self.user else "nbatahmin.app"))
        if not msg["List-Unsubscribe"] and self.user:
            msg["List-Unsubscribe"] = f"<mailto:{self.user}?subject=unsubscribe>, <{SITE}>"
        if self.dry:
            print("[deneme]", msg["To"], "|", msg["Subject"])
            return True
        try:
            if self.smtp is None:
                host, port = os.environ.get("SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("SMTP_PORT", "465"))
                if os.environ.get("SMTP_PLAIN"):  # yerel test sunucusu
                    self.smtp = smtplib.SMTP(host, port, timeout=30)
                else:
                    self.smtp = smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=30)
                    self.smtp.login(self.user, self.pw)
            self.smtp.send_message(msg)
        except Exception as e:  # tek adres sorunluysa diğerlerine devam
            print("gönderilemedi:", msg["To"].split("@")[0][:3] + "…", type(e).__name__)
            return False
        self.sent += 1
        print("gönderildi:", msg["Subject"])
        return True

    def close(self):
        if self.smtp:
            self.smtp.quit()


def people(db, flag):
    """Tercihi açık oyuncular: (uid, ad, e-posta)."""
    out = []
    for c in db.collection("contacts").stream():
        info = c.to_dict() or {}
        email = (info.get("email") or "").strip()
        if not info.get(flag) or not info.get("verified") or "@" not in email:
            continue  # yalnızca onaylanmış adreslere
        p = db.collection("players").document(c.id).get()
        if not p.exists:
            continue
        name = (p.to_dict() or {}).get("name", "")
        out.append((c.id, name[:1].upper() + name[1:], email))
    return out


def once(db, key):
    """Bu mail daha önce gönderildiyse None, gönderilmediyse kaydedilecek belge."""
    ref = db.collection("reminders").document(key)
    return None if ref.get().exists else ref


# ---------------------------------------------------------------- 1) hatırlatma
def reminders(db, mail, day, games, force):
    lock = games[0]["start"]
    now = datetime.now(timezone.utc)
    if not force and not (lock - BEFORE <= now < lock):
        print(f"hatırlatma: kilit {lock:%H:%MZ}, pencere dışında ({(lock - now).total_seconds() / 60:.0f} dk var)")
        return
    lock_tr = lock.astimezone(TR).strftime("%H:%M")
    for uid, name, email in people(db, "remind"):
        ref = once(db, f"{day}_{uid}")
        if not ref:
            continue
        refs = [db.collection("picks").document(f"{g['id']}_{uid}") for g in games]
        have = {x.id.split("_")[0] for x in db.get_all(refs) if x.exists}
        missing = [g for g in games if g["id"] not in have]
        daily = db.collection("daily").document(f"{day}_{uid}").get()
        d = daily.to_dict() if daily.exists else {}
        parts = []
        if missing:
            parts.append(f"{len(missing)} maç eksik" if len(missing) < len(games) else "bu gece hiç tahmin yapmadın")
        if not d.get("confGame"):
            parts.append("banko seçilmedi")
        if not d.get("dayPlayerId"):
            parts.append("günün oyuncusu seçilmedi")
        if not d.get("q"):
            parts.append("gecenin sorusu cevaplanmadı")
        if not parts:
            continue
        rows = "".join(f"<li>{escape(g['away'])} – {escape(g['home'])}</li>" for g in missing[:15])
        inner = (f'<p style="margin:0 0 10px">Selam {escape(name)}, {escape(", ".join(parts))}.</p>'
                 f'<p style="margin:0 0 12px;color:#5f6b78;font-size:14px">Bütün tahminler gecenin ilk maçı başlayınca, Türkiye saatiyle {lock_tr}\'de kilitlenir.</p>'
                 + (f'<ul style="margin:0 0 14px;padding-left:20px;font-size:14px">{rows}</ul>' if rows else ""))
        text = (f"Selam {name}, {', '.join(parts)}.\nBütün tahminler gecenin ilk maçı başlayınca, Türkiye saatiyle {lock_tr}'de kilitlenir.\n"
                + ("\nEksik maçlar:\n" + "\n".join(f"- {g['away']} – {g['home']}" for g in missing[:15]) if missing else ""))
        msg = build(email, f"🏀 Kilit {lock_tr}'de: {', '.join(parts)}", text, card(f"Kilit {lock_tr}'de", nice(day), inner, "Tahmin yap"))
        if mail.send(msg) and not mail.dry:
            ref.set({"at": firestore.SERVER_TIMESTAMP, "missing": len(missing)})


# ---------------------------------------------------------------- 2) sakatlık uyarısı
def injuries(db, mail, day, games):
    now = datetime.now(timezone.utc)
    if now >= games[0]["start"]:
        return  # kilitlendi, değiştirmek mümkün değil
    status, names = {}, {}
    for tid in {t for g in games for t in g["teams"]}:
        try:
            for a in get(f"{ESPN}/teams/{tid}/roster").get("athletes", []):
                inj = (a.get("injuries") or [{}])[0].get("status", "")
                status[str(a["id"])] = inj
                names[str(a["id"])] = a.get("displayName", "")
        except Exception as e:
            print("kadro alınamadı:", tid, type(e).__name__)
    out_ids = {pid for pid, st in status.items() if "out" in st.lower()}
    if not out_ids:
        print("sakatlık: seçilen oyuncularda sorun yok")
        return
    for uid, name, email in people(db, "remind"):
        hits = []
        refs = [db.collection("picks").document(f"{g['id']}_{uid}") for g in games]
        for snap in db.get_all(refs):
            if snap.exists and (snap.to_dict() or {}).get("scorerId") in out_ids:
                gid = snap.id.split("_")[0]
                g = next(x for x in games if x["id"] == gid)
                hits.append((snap.to_dict()["scorerId"], f"{g['away']} – {g['home']} maçının skorer seçimi"))
        daily = db.collection("daily").document(f"{day}_{uid}").get()
        dp = (daily.to_dict() or {}).get("dayPlayerId") if daily.exists else None
        if dp in out_ids:
            hits.append((dp, "günün oyuncusu seçimin"))
        new = []
        for pid, where in hits:
            ref = once(db, f"inj_{day}_{uid}_{pid}")
            if ref:
                new.append((pid, where, ref))
        if not new:
            continue
        lines = [f"{names.get(pid, 'Oyuncu')} bu gece oynamıyor ({where})" for pid, where, _ in new]
        lock_tr = games[0]["start"].astimezone(TR).strftime("%H:%M")
        inner = (f'<p style="margin:0 0 10px">Selam {escape(name)}, ESPN\'e göre seçtiğin oyunculardan biri bu gece oynamayacak:</p>'
                 f'<ul style="margin:0 0 12px;padding-left:20px;font-size:14px">{"".join(f"<li>{escape(x)}</li>" for x in lines)}</ul>'
                 f'<p style="margin:0 0 12px;color:#5f6b78;font-size:14px">Türkiye saatiyle {lock_tr}\'e kadar değiştirebilirsin.</p>')
        first = names.get(new[0][0], "Seçtiğin oyuncu")
        msg = build(email, f"⚠️ {first} bu gece oynamıyor", f"Selam {name},\n" + "\n".join(lines) + f"\nTürkiye saatiyle {lock_tr}'e kadar değiştirebilirsin.",
                    card("Seçtiğin oyuncu oynamıyor", nice(day), inner, "Seçimi değiştir"))
        if mail.send(msg) and not mail.dry:
            for _, _, ref in new:
                ref.set({"at": firestore.SERVER_TIMESTAMP})


# ---------------------------------------------------------------- 3) haftalık özet
def weekly(db, mail, force):
    now_tr = datetime.now(TR)
    if not force and not (now_tr.weekday() == 0 and now_tr.hour >= 10):
        return
    wk = os.environ.get("REMIND_WEEK") or (datetime.strptime(week_key(espn_today().strftime("%Y%m%d")), "%Y%m%d") - timedelta(days=7)).strftime("%Y%m%d")
    sc = load("scores.json", {})
    games_meta = load("games.json", {})
    days = {d: row for d, row in sc.get("days", {}).items() if week_key(d) == wk}
    if not days:
        print("haftalık: geçen hafta oynanmış gece yok")
        return
    pl = {d.id: (d.to_dict() or {}).get("name", "?") for d in db.collection("players").stream()}
    nm = lambda u: (pl.get(u, "?")[:1].upper() + pl.get(u, "?")[1:])
    tot = {}
    for row in days.values():
        for u, v in row.items():
            tot[u] = tot.get(u, 0) + v.get("tot", v.get("pts", 0))
    ranked = sorted(tot.items(), key=lambda x: -x[1])
    champ = ranked[0][0] if len(ranked) == 1 or ranked[0][1] > ranked[1][1] else None
    best_night = max(((u, v.get("tot", v.get("pts", 0)), d) for d, row in days.items() for u, v in row.items()), key=lambda x: x[1])
    best_game, worst_banko = None, None
    for gid, row in sc.get("games", {}).items():
        g = games_meta.get(gid)
        if not g or week_key(g["day"]) != wk:
            continue
        for u, r in row.items():
            if r.get("pick") and (not best_game or r["pts"] > best_game[1]):
                best_game = (u, r["pts"], g, r)
            if r.get("c") and r.get("w", 0) < 0 and not worst_banko:
                worst_banko = (u, g, r)
    end = (datetime.strptime(wk, "%Y%m%d") + timedelta(days=6)).strftime("%Y%m%d")
    span = f"{nice(wk)} – {nice(end)}"
    rows = "".join(f'<tr><td style="padding:4px 10px 4px 0">{i + 1}.</td><td style="padding:4px 10px 4px 0;font-weight:bold">{escape(nm(u))}</td><td style="padding:4px 0;text-align:right">{p} puan</td></tr>'
                   for i, (u, p) in enumerate(ranked))
    facts = [f"En iyi gece: {nm(best_night[0])}, {nice(best_night[2])} gecesi {best_night[1]} puan"]
    if best_game:
        u, p, g, r = best_game
        facts.append(f"En iyi tahmin: {nm(u)}, {g['away']['abbr']} – {g['home']['abbr']} maçından {p} puan")
    if worst_banko:
        u, g, r = worst_banko
        facts.append(f"Haftanın yanan bankosu: {nm(u)}, {g['away']['abbr']} – {g['home']['abbr']}")
    head = f"Haftanın şampiyonu {nm(champ)}" if champ else "Hafta berabere bitti"
    inner = ('<p style="margin:0 0 10px">Geçen haftanın puan durumu:</p>'
             f'<table style="font-size:15px;margin:0 0 12px">{rows}</table>'
             f'<ul style="margin:0 0 14px;padding-left:20px;font-size:14px;color:#334">{"".join(f"<li>{escape(x)}</li>" for x in facts)}</ul>')
    text = head + "\n\n" + "\n".join(f"{i + 1}. {nm(u)}: {p} puan" for i, (u, p) in enumerate(ranked)) + "\n\n" + "\n".join(facts)
    for uid, name, email in people(db, "weekly"):
        ref = once(db, f"week_{wk}_{uid}")
        if not ref:
            continue
        msg = build(email, f"🏆 Haftalık özet ({span}): {head}", f"Selam {name},\n\n" + text, card(head, span, inner))
        if mail.send(msg) and not mail.dry:
            ref.set({"at": firestore.SERVER_TIMESTAMP})


def main():
    dry, force = "--dry" in sys.argv, "--now" in sys.argv
    db = init()
    if db is None:
        print("FIREBASE_SA yok; mailler devre dışı.")
        return 0
    mail = Mailer(dry)
    if not mail.ok():
        print("GMAIL_USER / GMAIL_APP_PASSWORD yok; mail gönderilmiyor.")
        return 0
    day = os.environ.get("REMIND_DAY") or espn_today().strftime("%Y%m%d")  # REMIND_DAY: yalnızca test
    games = night_games(day)
    upcoming = [g for g in games if g["state"] == "pre"]
    if games and len(upcoming) == len(games):
        reminders(db, mail, day, games, force)
        injuries(db, mail, day, games)
    else:
        print(day, "maç yok ya da gece başladı")
    weekly(db, mail, force)
    mail.close()
    print(f"{day}: {mail.sent} mail")
    return 0


if __name__ == "__main__":
    sys.exit(main())

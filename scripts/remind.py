"""Mailler (GitHub Actions, 10 dakikada bir).

Spama düşmemek için kişi başına günde en fazla bir "gecenin özeti" maili gider: hatırlatma, sakatlık ve uzun vade
haberleri bu tek mailde toplanır (Outbox). Özet gittikten sonra çıkan acil bir haber (bu geceki seçimin oynamıyor,
uzun vade kilidine birkaç saat kaldı) için o gün en fazla bir ek mail gider. Haftalık özet ve kod mailleri ayrıdır.
Mailler sade, kişisel mail gibi görünür (gizli önizleme metni, düğme, koyu başlık yok).

Bölümler:

1. Hatırlatma: her akşam 21.00'de (Türkiye) eksik tahmini olanlara bir kez. Gecenin ilk maçı
   21.00'den önceyse maçtan 1 saat önce.
2. Sakatlık uyarısı: skorer ya da günün oyuncusu olarak seçilen oyuncu ESPN'de "Out" görünürse, kilitten önce.
   Uzun vade: haftanın/ayın oyuncusu ya da sezon ödülü seçimi sakatlanırsa ve sezon seçimi 65 maç kuralına
   yaklaşır ya da takılırsa (takımın oynadığı maç - oyuncunun oynadığı maç >= 14 / > 17).
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
        python scripts/remind.py --now   (hatırlatma saatini beklemeden çalışır)
"""
import json
import os
import smtplib
import ssl
import sys
from datetime import datetime, time, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from html import escape
from zoneinfo import ZoneInfo

import firebase_admin
from firebase_admin import credentials, firestore

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sync import CONFIG, PERGAME_FROM, inj_out, espn_today, get, load, lock_gap, scoreboard, week_key  # noqa: E402

TR = ZoneInfo("Europe/Istanbul")
REMIND_AT = CONFIG.get("remindAt", "21:00")                       # her akşam bu saatte (Türkiye)
EARLY = timedelta(minutes=int(CONFIG.get("remindEarlyMinutes", 60)))  # ilk maç bundan önceyse maçtan bu kadar önce


def remind_time(lock):
    """Hatırlatma anı: gecenin ilk maçı 21.00'den sonraysa o akşam 21.00, önceyse maçtan 1 saat önce."""
    lock_tr = lock.astimezone(TR)
    # gece yarısından sonraki maçlar (ör. 02.30) bir önceki akşama aittir
    evening = (lock_tr - timedelta(hours=10)).date()
    hh, mm = (int(x) for x in REMIND_AT.split(":"))
    at = datetime.combine(evening, time(hh, mm), TR)
    return lock - EARLY if lock_tr <= at else at
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
    out.sort(key=lambda g: g["start"])
    if out:  # kilit: 4 Kasım'dan itibaren her maç kendi saatinden 10 dk önce; banko/günün oyuncusu/soru gecenin ilk maçından 10 dk önce
        gap, first = lock_gap(day), out[0]["start"]
        for g in out:
            g["night_lock"] = first - gap
            g["lock"] = (g["start"] if day >= PERGAME_FROM else first) - gap
    return out


MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
nice = lambda d: f"{int(d[6:])} {MONTHS[int(d[4:6]) - 1]}"  # ESPN (ABD) tarihi, sitedeki gibi


def card(title, sub, inner, button="Siteye git", pre=""):
    """Bütün mailler için sade görünüm: kişisel mail gibi, tek düz link. (sub ve pre geriye uyum için duruyor.)"""
    return f"""<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>{escape(title)}</title></head>
<body style="margin:0;padding:12px"><div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2330;max-width:560px">
<p style="margin:0 0 12px;font-size:17px"><b>{escape(title)}</b></p>
{inner}
<p style="margin:14px 0 0">{escape(button)}: <a href="{escape(SITE)}">{escape(SITE)}</a></p>
<p style="margin:20px 0 0;color:#80868f;font-size:12px">Bu maili NBA Tahmin ligindeki arkadaşların arasında olduğun için alıyorsun. İstemiyorsan sitede profilinden kapatabilir ya da bu maile cevap verebilirsin.</p>
</div></body></html>"""


def build(email, subject, text, html, name="", kind="bildirim"):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["To"] = formataddr((name, email)) if name else email
    msg.set_content(text + f"\n\n{SITE}\n\nBu maili NBA Tahmin ligindeki arkadaşların arasında olduğun için alıyorsun. İstemiyorsan sitede profilinden kapatabilirsin.\n")
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
        if self.user and not msg["Reply-To"]:
            msg["Reply-To"] = formataddr(("NBA Tahmin", self.user))
        # otomatik bildirim olduğunu açıkça söyleyen başlıklar (otomatik yanıtları da engeller)
        msg["Auto-Submitted"] = "auto-generated"
        msg["Content-Language"] = "tr"
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


_PEOPLE = {}


def people(db, flag):
    """Tercihi açık oyuncular: (uid, ad, e-posta). Firestore okuma kotası için bir çalışmada bir kere okunur."""
    if "all" not in _PEOPLE:
        names = {d.id: (d.to_dict() or {}).get("name", "") for d in db.collection("players").stream()}
        _PEOPLE["all"] = [(c.id, c.to_dict() or {}) for c in db.collection("contacts").stream() if c.id in names]
        _PEOPLE["names"] = names
    out = []
    for uid, info in _PEOPLE["all"]:
        email = (info.get("email") or "").strip()
        if not info.get(flag) or not info.get("verified") or "@" not in email:
            continue  # yalnızca onaylanmış adreslere
        name = _PEOPLE["names"].get(uid, "")
        out.append((uid, name[:1].upper() + name[1:], email))
    return out


def once(db, key):
    """Bu mail daha önce gönderildiyse None, gönderilmediyse kaydedilecek belge."""
    ref = db.collection("reminders").document(key)
    return None if ref.get().exists else ref


# ---------------------------------------------------------------- günlük tek mail
class Outbox:
    """Bölümleri kişi başına toplar; günde bir özet + gerekirse bir acil ek mail gönderir.
    Bölüm: (başlık, paragraflar, maddeler, gönderilince yazılacak 'reminders' belgeleri, acil mi)."""

    def __init__(self, db, mail, day, digest_at):
        self.db, self.mail, self.day, self.digest_at, self.box = db, mail, day, digest_at, {}

    def add(self, uid, name, email, title, paras, items, refs, urgent=False, order=5):
        b = self.box.setdefault(uid, {"name": name, "email": email, "secs": []})
        b["secs"].append({"title": title, "paras": paras, "items": items, "refs": refs, "urgent": urgent, "order": order})

    def flush(self):
        now = datetime.now(timezone.utc)
        due = now >= self.digest_at
        for uid, b in self.box.items():
            st_ref = self.db.collection("reminders").document(f"mail_{self.day}_{uid}")
            snap = st_ref.get()
            st = snap.to_dict() if snap.exists else {}
            if not st.get("digest"):
                if not due:
                    continue
                secs, flag = b["secs"], "digest"
            else:
                secs, flag = [x for x in b["secs"] if x["urgent"]], "extra"
                if not secs or st.get("extra"):
                    continue
            secs = sorted(secs, key=lambda x: x["order"])
            name = b["name"]
            if flag == "extra":
                subject = secs[0]["title"]
            elif secs[0]["order"] == 0:
                subject = f"Bu geceki tahminlerin ({nice(self.day)})"
            else:
                subject = f"NBA Tahmin notların ({nice(self.day)})" if len(secs) > 1 else secs[0]["title"]
            html, text = [f'<p style="margin:0 0 12px">Selam {escape(name)},</p>'], [f"Selam {name},"]
            for x in secs:
                html.append(f'<p style="margin:14px 0 4px"><b>{escape(x["title"])}</b></p>')
                html += [f'<p style="margin:0 0 6px">{escape(t)}</p>' for t in x["paras"]]
                if x["items"]:
                    html.append('<ul style="margin:0 0 8px;padding-left:20px">' + "".join(f"<li>{escape(t)}</li>" for t in x["items"]) + "</ul>")
                text += ["", x["title"]] + x["paras"] + [f"- {t}" for t in x["items"]]
            msg = build(b["email"], subject, "\n".join(text),
                        card("Bu gece" if flag == "digest" and secs[0]["order"] == 0 else "NBA Tahmin", "", "".join(html), "Siteye git"), name)
            if self.mail.send(msg) and not self.mail.dry:
                for x in secs:
                    for r in x["refs"]:
                        r.set({"at": firestore.SERVER_TIMESTAMP})
                st_ref.set({flag: True, "at": firestore.SERVER_TIMESTAMP}, merge=True)


# ---------------------------------------------------------------- 1) hatırlatma
def reminders(db, out, day, games, force):
    lock = games[0]["night_lock"]
    now = datetime.now(timezone.utc)
    when = remind_time(lock)
    if not force and not (when <= now < lock):
        print(f"hatırlatma: {when.astimezone(TR):%d.%m %H:%M}'de gidecek (kilit {lock.astimezone(TR):%H:%M}), şimdi değil")
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
        per = day >= PERGAME_FROM
        rule = (f"Her maç başlamadan 10 dakika önce kilitlenir; ilk kilit saati {lock_tr} (Türkiye saati). Banko, günün oyuncusu ve gecenin sorusu da bu ilk kilitle kapanır."
                if per else f"Bütün tahminlerin kilit saati {lock_tr} (Türkiye saati).")
        head = ", ".join(parts)
        items = [f"{g['away']} – {g['home']} (kilit {g['lock'].astimezone(TR):%H:%M})" for g in missing[:15]]
        out.add(uid, name, email, "Bu gecenin tahminleri", [head[:1].upper() + head[1:] + ".", rule], items, [ref], order=0)


# ---------------------------------------------------------------- 2) sakatlık uyarısı
INJ_PART = {"Knee": "diz", "Ankle": "ayak bileği", "Foot": "ayak", "Hamstring": "arka adale", "Calf": "baldır", "Back": "bel",
            "Hip": "kalça", "Shoulder": "omuz", "Wrist": "el bileği", "Hand": "el", "Finger": "parmak", "Groin": "kasık",
            "Achilles": "aşil", "Elbow": "dirsek", "Illness": "hastalık", "Concussion": "beyin sarsıntısı", "Thigh": "uyluk",
            "Toe": "ayak parmağı", "Rest": "dinlenme", "Personal": "kişisel neden", "Neck": "boyun", "Abdomen": "karın",
            "Quadriceps": "ön adale", "Leg": "bacak", "Chest": "göğüs", "Face": "yüz", "Eye": "göz", "Oblique": "yan karın", "Rib": "kaburga"}


def injury_list():
    """ESPN sakatlık listesi: {oyuncuId: {name, out, why, back}}. 'Out' ve ceza oynamıyor sayılır."""
    import re
    out = {}
    try:
        d = get("https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/injuries")
    except Exception as e:
        print("sakatlık listesi alınamadı:", type(e).__name__)
        return out
    for t in d.get("injuries", []):
        for i in t.get("injuries", []):
            a = i.get("athlete", {})
            pid = next((m.group(1) for l in a.get("links", []) for m in [re.search(r"/id/(\d+)", l.get("href", ""))] if m), None)
            if not pid:
                continue
            st, det = i.get("status", ""), i.get("details") or {}
            why = "ceza" if st == "Suspension" else INJ_PART.get(det.get("type", ""), (det.get("type") or "sakatlık").lower())
            out[pid] = {"name": a.get("displayName", "Oyuncu"), "out": inj_out(i), "why": why,
                        "back": det.get("returnDate", "")}
    return out


def back_txt(info):
    r = info.get("back")
    if not r:
        return ""
    try:
        d = datetime.strptime(r, "%Y-%m-%d")
        return f", tahmini dönüş {d.day} {MONTHS[d.month - 1]}"
    except ValueError:
        return ""


def injuries(db, out, day, games, inj):
    now = datetime.now(timezone.utc)
    out_ids = {pid for pid, x in inj.items() if x["out"]}
    if not out_ids:
        return
    night_open = now < games[0]["night_lock"]
    for uid, name, email in people(db, "remind"):
        hits = []
        refs = [db.collection("picks").document(f"{g['id']}_{uid}") for g in games if now < g["lock"]]
        for snap in db.get_all(refs) if refs else []:
            sid = (snap.to_dict() or {}).get("scorerId") if snap.exists else None
            if sid in out_ids:
                g = next(x for x in games if x["id"] == snap.id.split("_")[0])
                hits.append((sid, f"{g['away']} – {g['home']} maçının skorer seçimin", g["lock"]))
        if night_open:
            daily = db.collection("daily").document(f"{day}_{uid}").get()
            dp = (daily.to_dict() or {}).get("dayPlayerId") if daily.exists else None
            if dp in out_ids:
                hits.append((dp, "günün oyuncusu seçimin", games[0]["night_lock"]))
        new = [(pid, where, lk, ref) for pid, where, lk in hits for ref in [once(db, f"inj_{day}_{uid}_{pid}")] if ref]
        if not new:
            continue
        lines = [f"{inj[pid]['name']} bu gece oynamıyor ({inj[pid]['why']}{back_txt(inj[pid])}). Bu, {where}. Kilide kadar değiştirebilirsin (kilit saati {lk.astimezone(TR):%H:%M}, Türkiye saati)."
                 for pid, where, lk, _ in new]
        first = inj[new[0][0]]["name"]
        out.add(uid, name, email, f"{first} bu gece oynamıyor" if len(new) == 1 else "Seçtiğin oyuncular bu gece oynamıyor",
                ["ESPN'e göre seçtiğin oyunculardan biri bu gece oynamayacak:" if len(new) == 1 else "ESPN'e göre seçtiğin bazı oyuncular bu gece oynamayacak:"],
                lines, [r for *_, r in new], urgent=True, order=1)


# ---------------------------------------------------------------- 2b) uzun vade uyarıları
LT_NAMES = {"cfe": "kupa finalisti (Doğu)", "cfw": "kupa finalisti (Batı)", "e": "haftanın oyuncusu (Doğu)", "w": "haftanın oyuncusu (Batı)", "pe": "ayın oyuncusu (Doğu)", "pw": "ayın oyuncusu (Batı)",
            "re": "ayın çaylağı (Doğu)", "rw": "ayın çaylağı (Batı)", "de": "ayın savunmacısı (Doğu)", "dw": "ayın savunmacısı (Batı)",
            "cmvp": "NBA Kupası MVP'si", "mvp": "Most Valuable Player", "roy": "Rookie of the Year", "dpoy": "Defensive Player of the Year", "mip": "Most Improved Player", "smoy": "Sixth Man of the Year"}


def lt_lock(k):
    if k[0] == "w":
        return datetime.strptime(k[2:], "%Y%m%d").replace(tzinfo=timezone.utc) + timedelta(hours=71)
    if k[0] == "m":
        return datetime(int(k[2:6]), int(k[6:8]), 15, 17, tzinfo=timezone.utc)
    if k[0] == "c":
        return datetime(2026, 12, 4, 17, tzinfo=timezone.utc)
    if k[0] == "k":
        return datetime(2026, 12, 1, 17, tzinfo=timezone.utc)
    return datetime(2027, 1, 15, 17, tzinfo=timezone.utc)


def lt_alerts(db, out, inj):
    today = espn_today().strftime("%Y%m%d")
    y, m = int(today[:4]), int(today[4:6])
    mk = "m_202611" if (y, m) in ((2026, 10), (2026, 11)) else f"m_{y}{m:02d}"
    keys = ["w_" + week_key(today), mk, "c_2026", "s_2027"]   # k_2027 takım seçimi: sakatlık uyarısı yok
    now = datetime.now(timezone.utc)
    # 65 maç kuralı: takımın oynadığı - oyuncunun oynadığı maç
    games = load("games.json", {})
    team_gp = {}
    for g in games.values():
        if g.get("seasonType") == 2:
            for side in ("home", "away"):
                team_gp[g[side]["abbr"]] = team_gp.get(g[side]["abbr"], 0) + 1
    pst = load("players.json", {}).get("p", {})
    swap_open = now < datetime(2027, 3, 1, tzinfo=timezone.utc)
    for uid, name, email in people(db, "remind"):
        items = []   # (anahtar, satır)
        for k in keys:
            snap = db.collection("lt").document(f"{k}_{uid}").get()
            if not snap.exists:
                continue
            d = snap.to_dict() or {}
            picks = dict(d.get("picks") or {})
            for c, sw in (d.get("swaps") or {}).items():
                picks[c] = sw.get("to", picks.get(c))
            names = d.get("names") or {}
            locked = now >= lt_lock(k)
            for c, pid in picks.items():
                if c in ("coy", "cw", "cfe", "cfw", "champ", "fe", "fw") or not pid:
                    continue
                pid = str(pid)
                who = inj.get(pid, {}).get("name") or names.get(c) or pst.get(pid, {}).get("n", "Seçtiğin oyuncu")
                cat = LT_NAMES.get(c, c)
                if pid in inj and inj[pid]["out"]:
                    tail = (f"Tur henüz kilitlenmedi, değiştirebilirsin (kilit: {lt_lock(k).astimezone(TR).day} {MONTHS[lt_lock(k).astimezone(TR).month - 1]}, saat {lt_lock(k).astimezone(TR):%H:%M})." if not locked
                            else "Tur kilitlendi; seçim artık değişmiyor, bilgin olsun.")
                    items.append((f"ltinj_{k}_{uid}_{pid}",
                                  f"{who} sakat ({inj[pid]['why']}{back_txt(inj[pid])}). {cat[:1].upper() + cat[1:]} seçimindi. {tail}"))
                if k[0] == "s" and pid in pst:
                    p = pst[pid]
                    missed = team_gp.get(p.get("t"), 0) - p.get("gp", 0)
                    if missed > 17 and not (d.get("swaps") or {}).get(c):
                        tail = ("1 Mart'a kadar bu seçimi bir kere değiştirebilirsin; yeni seçim puanın yarısını alır." if swap_open
                                else "Değiştirme süresi doldu.")
                        items.append((f"lt65_{uid}_{c}_{pid}", f"{who} bu sezon {missed} maç kaçırdı ve 65 maç kuralına takıldı; {cat} adayı olamaz. {tail}"))
                    elif missed >= 14:
                        items.append((f"lt65w_{uid}_{c}_{pid}", f"{who} bu sezon {missed} maç kaçırdı. {18 - missed} maç daha kaçırırsa 65 maç kuralına takılır ve {cat} adayı olamaz."))
        new = [(line, ref) for key, line in items for ref in [once(db, key)] if ref]
        if not new:
            continue
        lines = [x for x, _ in new]
        subj = "Uzun vade seçimin 65 maç kuralına takıldı" if any("takıldı" in x for x in lines) else "Uzun vade seçiminle ilgili sakatlık haberi"
        out.add(uid, name, email, subj, [], lines, [r for _, r in new], order=3)


# ---------------------------------------------------------------- 2c) uzun vade kilit hatırlatması
LT_TITLES = {"w": "Haftanın oyuncusu", "m": "Ayın ödülleri", "c": "NBA Kupası", "k": "Konferans sıralaması", "s": "Sezon ödülleri"}
LT_COUNT = {"w": 2, "m": 6, "c": 4, "k": 12, "s": 9}


def lt_lock_mail(db, out):
    """Kilide 36 saatten az kalan uzun vade turunda eksik seçimi olanlara bir kez (özet mailde; son 6 saatte acil)."""
    today = espn_today().strftime("%Y%m%d")
    y, m = int(today[:4]), int(today[4:6])
    mk = "m_202611" if (y, m) in ((2026, 10), (2026, 11)) else f"m_{y}{m:02d}"
    nxt = (datetime.strptime(week_key(today), "%Y%m%d") + timedelta(days=7)).strftime("%Y%m%d")
    now = datetime.now(timezone.utc)
    due = [k for k in ("w_" + week_key(today), "w_" + nxt, mk, "c_2026", "s_2027") if timedelta(0) < lt_lock(k) - now <= timedelta(hours=36)]
    if not due:
        return
    for uid, name, email in people(db, "remind"):
        rows = []
        for k in due:
            snap = db.collection("lt").document(f"{k}_{uid}").get()
            n = len([v for v in ((snap.to_dict() or {}).get("picks") or {}).values() if v]) if snap.exists else 0
            if n >= LT_COUNT[k[0]]:
                continue
            ref = once(db, f"ltlock_{k}_{uid}")
            if ref:
                lk = lt_lock(k).astimezone(TR)
                rows.append((ref, f"{LT_TITLES[k[0]]}: {n}/{LT_COUNT[k[0]]} seçim yaptın. Kilit {lk.day} {MONTHS[lk.month - 1]}, saat {lk:%H:%M}."))
        if not rows:
            continue
        lines = [x for _, x in rows]
        soon = any(lt_lock(k) - now <= timedelta(hours=6) for k in due)
        out.add(uid, name, email, "Uzun vade tahminlerin kilitlenmek üzere", ["Uzun vade tahminlerinde eksik seçimin var:"], lines,
                [r for r, _ in rows], urgent=soon, order=2)


# ---------------------------------------------------------------- 2d) sorun bildirimleri -> yönetici
KIND_TR = {"sorun": "Sorun", "istek": "İstek / öneri", "soru": "Soru", "diger": "Diğer"}


def admin_mails(db):
    """Gönderen Gmail hesabı + yöneticilerin onaylı mail adresleri (tekrarsız)."""
    out = []
    me = os.environ.get("GMAIL_USER", "").strip()
    if me:
        out.append(me)
    try:
        adm = db.collection("config").document("admin").get()
        for uid in (adm.to_dict() or {}).get("uids", []) if adm.exists else []:
            c = db.collection("contacts").document(uid).get()
            c = c.to_dict() if c.exists else {}
            e = (c or {}).get("email", "").strip()
            if c.get("verified") and "@" in e and e.lower() not in [x.lower() for x in out]:
                out.append(e)
    except Exception as e:
        print("yönetici adresleri alınamadı:", type(e).__name__)
    return out


def report_mail(db, mail):
    """Yeni istek / sorun bildirimlerini yöneticilere bir kez mail olarak yollar; yanıtla deyince bildirenin onaylı adresine gider."""
    tos = admin_mails(db)
    if not tos:
        return
    pl = None
    for r in db.collection("reports").stream():
        d = r.to_dict() or {}
        ref = once(db, f"rep_{r.id}")
        if not ref:
            continue
        if pl is None:
            pl = {x.id: (x.to_dict() or {}).get("name", "?") for x in db.collection("players").stream()}
        who = pl.get(d.get("uid"), "?")
        kind = KIND_TR.get(d.get("kind"), "Sorun")
        reply = None
        try:
            c = db.collection("contacts").document(d.get("uid") or "-").get()
            c = c.to_dict() if c.exists else {}
            if c and c.get("verified") and "@" in (c.get("email") or ""):
                reply = c["email"].strip()
        except Exception:
            pass
        text = (f"{who} yeni bir bildirim gönderdi: {kind}\n(sürüm {d.get('v', '?')}, sekme {d.get('tab', '?')}, ekran {d.get('w', '?')} px)\n\n{d.get('text', '')}\n\n"
                + (f"Yanıtla dersen cevabın {reply} adresine gider.\n" if reply else "Bu oyuncunun onaylı mail adresi yok; cevabı sitede ya da sohbette verebilirsin.\n") + f"\n{d.get('ua', '')}")
        inner = (f'<p style="margin:0 0 10px"><b>{escape(who)}</b> yeni bir bildirim gönderdi: <b>{escape(kind)}</b></p>'
                 f'<p style="margin:0 0 10px;padding:10px;background:#f2f4f7;border-radius:8px;white-space:pre-wrap">{escape(d.get("text", ""))}</p>'
                 + (f'<p style="margin:0 0 10px">Yanıtla dersen cevabın <b>{escape(reply)}</b> adresine gider.</p>' if reply else '<p style="margin:0 0 10px">Bu oyuncunun onaylı mail adresi yok; cevabı sitede ya da sohbette verebilirsin.</p>')
                 + f'<p style="margin:0 0 12px;color:#5f6b78;font-size:12px">Sürüm {escape(str(d.get("v", "?")))} · sekme {escape(str(d.get("tab", "?")))} · {escape(str(d.get("ua", "")))}</p>')
        ok = False
        for to in tos:
            msg = build(to, f"{kind}: {who}", text, card(f"NBA Tahmin · {kind}", "yönetim", inner, "Yönetim paneline git"), "", "bildirim")
            if reply:
                msg["Reply-To"] = formataddr((who, reply))
            ok = mail.send(msg) or ok
        if ok and not mail.dry:
            ref.set({"at": firestore.SERVER_TIMESTAMP})


# ---------------------------------------------------------------- 3) haftalık özet
VOW = "aeıioöuü"
FRONT_NAMES = {"kemal", "celal", "cemal", "bilal", "hilal", "nihal", "hayal", "iclal", "meral", "celâl", "kemâl", "cemâl"}


def tr_gen(n):
    """İlgi eki: Kemal'in, Mustafa'nın, Andaç'ın."""
    low = n.replace("I", "ı").replace("İ", "i").lower()
    v = next((c for c in reversed(low) if c in VOW), "e")
    if low.split()[-1:] and low.split()[-1] in FRONT_NAMES:  # Kemal'in, Celal'in (ince l)
        v = "e"
    suf = {"a": "ın", "ı": "ın", "e": "in", "i": "in", "o": "un", "u": "un", "ö": "ün", "ü": "ün"}[v]
    return n + "'" + ("n" if low[-1:] in VOW else "") + suf


def week_notes(days, games_rows, games_meta, wk, nm, ranked):
    """Haftalık maile insan gibi yazılmış birkaç cümle."""
    notes = []
    if len(ranked) > 1:
        (u1, p1), (u2, p2) = ranked[0], ranked[1]
        if p1 > p2:
            d = p1 - p2
            notes.append(f"{nm(u1)} haftayı {p1} puanla kapattı; {nm(u2)} {d} puan geride kaldı." if d > 2
                         else f"Kıl payı bir hafta: {nm(u1)}, {nm(u2)} karşısında sadece {d} puan farkla öne geçti.")
        else:
            notes.append(f"Hafta {nm(u1)} ile {nm(u2)} arasında {p1}-{p2} berabere bitti.")
    nights = {}
    for d, row in days.items():
        vals = {u: v.get("tot", v.get("pts", 0)) for u, v in row.items()}
        if not vals:
            continue
        m = max(vals.values())
        w = [u for u, x in vals.items() if x == m]
        if len(w) == 1:
            nights[w[0]] = nights.get(w[0], 0) + 1
    if nights:
        u, n = max(nights.items(), key=lambda x: x[1])
        if n >= 2:
            notes.append(f"Gecelerin hâkimi {nm(u)}: haftanın {n} gecesini kazandı.")
    st = {}
    for gid, row in games_rows.items():
        g = games_meta.get(gid)
        if not g or week_key(g["day"]) != wk:
            continue
        for u, r in row.items():
            if not r.get("pick"):
                continue
            x = st.setdefault(u, {"n": 0, "ok": 0, "c": 0, "cok": 0, "full": 0})
            x["n"] += 1
            x["ok"] += r.get("w", 0) > 0
            if r.get("c"):
                x["c"] += 1
                x["cok"] += r.get("w", 0) > 0
            x["full"] += r.get("w", 0) > 0 and r.get("m", 0) > 0 and r.get("s", 0) > 0
    acc = [(u, x["ok"] / x["n"], x) for u, x in st.items() if x["n"] >= 5]
    if acc:
        u, a, x = max(acc, key=lambda t: t[1])
        notes.append(f"Kazananı en iyi bilen {nm(u)} oldu: {x['n']} maçın {x['ok']} tanesinde doğru taraftaydı (%{round(a * 100)}).")
    bk = [(u, x) for u, x in st.items() if x["c"] >= 3]
    if bk:
        u, x = max(bk, key=lambda t: (t[1]["cok"] / t[1]["c"], t[1]["c"]))
        if x["cok"] == x["c"]:
            notes.append(f"{nm(u)} bankoda hata yapmadı: {x['c']} bankonun hepsi tuttu.")
        elif x["cok"] / x["c"] >= 0.6:
            notes.append(f"{tr_gen(nm(u))} bankoları sağlamdı: {x['c']} bankonun {x['cok']} tanesi tuttu.")
    full = [(u, x["full"]) for u, x in st.items() if x["full"] > 0]
    if full:
        u, n = max(full, key=lambda t: t[1])
        notes.append(f"{nm(u)} {n} maçta kazanan, fark ve en skorerin üçünü birden bildi." if n > 1
                     else f"{nm(u)} bir maçta kazanan, fark ve en skorerin üçünü birden bildi.")
    return notes


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
    # o hafta açıklanan uzun vade sonuçlarının puanları da haftaya eklenir
    lt_week = {}
    for u, x in (sc.get("lt") or {}).items():
        for k, p in (x.get("rounds") or {}).items():
            d = (sc.get("ltDays") or {}).get(k)
            if d and week_key(d) == wk:
                lt_week[u] = lt_week.get(u, 0) + p
                tot[u] = tot.get(u, 0) + p
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
    if lt_week:
        facts.append("Uzun vade puanları: " + ", ".join(f"{nm(u)} +{p}" for u, p in sorted(lt_week.items(), key=lambda x: -x[1])))
    head = f"Haftanın şampiyonu {nm(champ)}" if champ else "Hafta berabere bitti"
    notes = week_notes(days, sc.get("games", {}), games_meta, wk, nm, ranked)
    notes_html = "".join(f'<p style="margin:0 0 8px">{escape(x)}</p>' for x in notes)
    inner = ((f'<div style="margin:0 0 14px;font-size:15px;line-height:1.5">{notes_html}</div>' if notes else "")
             + '<p style="margin:0 0 10px">Geçen haftanın puan durumu:</p>'
             f'<table style="font-size:15px;margin:0 0 12px">{rows}</table>'
             f'<ul style="margin:0 0 14px;padding-left:20px;font-size:14px;color:#334">{"".join(f"<li>{escape(x)}</li>" for x in facts)}</ul>')
    text = head + "\n\n" + ("\n".join(notes) + "\n\n" if notes else "") + "\n".join(f"{i + 1}. {nm(u)}: {p} puan" for i, (u, p) in enumerate(ranked)) + "\n\n" + "\n".join(facts)
    for uid, name, email in people(db, "weekly"):
        ref = once(db, f"week_{wk}_{uid}")
        if not ref:
            continue
        msg = build(email, f"Haftalık özet ({span}): {head}", f"Selam {name},\n\n" + text, card(head, span, inner, pre=notes[0] if notes else head), name, "haftalik")
        if mail.send(msg) and not mail.dry:
            ref.set({"at": firestore.SERVER_TIMESTAMP})


def _due(secs):
    """Döngü 10 dakikada bir çağırır; Firestore okuma kotası için 20 dakikada bir çalışılır."""
    import tempfile, time as _t
    f = os.path.join(tempfile.gettempdir(), "nbat_remind")
    try:
        if _t.time() - os.path.getmtime(f) < secs:
            return False
    except OSError:
        pass
    open(f, "w").close()
    return True


def main():
    dry, force = "--dry" in sys.argv, "--now" in sys.argv
    if not (dry or force or os.environ.get("REMIND_DAY")) and not _due(19 * 60):
        print("mailler: son çalışmadan beri 20 dakika geçmedi")
        return 0
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
    inj = injury_list()
    # günün özet saati: maç varsa hatırlatma saati, yoksa akşam 21.00 (Türkiye)
    hh, mm = (int(x) for x in REMIND_AT.split(":"))
    digest_at = remind_time(games[0]["night_lock"]) if games else datetime.combine(datetime.strptime(day, "%Y%m%d").date(), time(hh, mm), TR)
    if force:
        digest_at = datetime.now(timezone.utc)
    out = Outbox(db, mail, day, digest_at)
    if games and len(upcoming) == len(games):
        reminders(db, out, day, games, force)
    if games and upcoming:
        injuries(db, out, day, games, inj)
    else:
        print(day, "maç yok ya da gece bitti")
    # uzun vade sakatlık / 65 maç uyarıları 3 saatte bir yeter (Firestore okuma kotası)
    now_utc = datetime.now(timezone.utc)
    if force or (now_utc.hour % 3 == 0 and now_utc.minute < 20):
        lt_alerts(db, out, inj)
    lt_lock_mail(db, out)
    out.flush()
    report_mail(db, mail)
    # uzun vade sonuçları (Wikipedia) saatte bir
    if force or datetime.now(timezone.utc).minute < 20:
        try:
            from awards import auto_awards
            auto_awards(db, dry)
        except Exception as e:
            print("otomatik ödüller çalışmadı:", type(e).__name__, e)
    weekly(db, mail, force)
    mail.close()
    print(f"{day}: {mail.sent} mail")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Sitenin açıldığını denetler (site-check.yml çalıştırır).

  python scripts/sitecheck.py csp          index.html'deki CSP özetleri satır içi betiklerle uyuşuyor mu (uymuyorsa çıkış 1)
  python scripts/sitecheck.py csp --fix    uymuyorsa index.html'i düzeltir (iş akışı sonra commit eder)
  python scripts/sitecheck.py live         canlı siteyi gerçek bir tarayıcıyla açar; açılış ekranı 25 saniyede
                                           kalkmazsa ya da tarayıcı bir betiği engellerse çıkış 1 ve (önceki denetim
                                           başarılıysa) GMAIL_USER adresine uyarı maili

12 Kasım 2026: sürüm numarası elle değiştirilince satır içi betiğin özeti tutmadı, tarayıcı açılış betiğini
engelledi ve site yaklaşık 10 dakika herkeste "Maçlar yükleniyor" ekranında kaldı. Bu denetim o yüzden var.
"""
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from csp import csp  # noqa: E402

SITE = os.environ.get("SITE_URL", "https://andacdlgn.github.io/nba-tahmin/")


def check_csp(fix):
    ix = ROOT / "index.html"
    t = ix.read_text("utf-8")
    good = csp(t)
    if good == t:
        print("CSP özetleri doğru.")
        return 0
    if fix:
        ix.write_text(good, "utf-8")
        print("CSP özetleri tutmuyordu; index.html düzeltildi.")
        return 0
    print("CSP özetleri tutmuyor! Düzeltmek için: python scripts/sitecheck.py csp --fix")
    return 1


def check_live():
    from playwright.sync_api import sync_playwright

    errs, problem = [], None
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Content Security Policy" in m.text else None)
        pg.on("pageerror", lambda e: errs.append("Sayfa hatası: " + str(e)))
        try:
            pg.goto(f"{SITE}?check={int(time.time())}", wait_until="domcontentloaded", timeout=45000)
            # sayfanın CSP'si eval'e izin vermez; bu yüzden betik değil seçici ile bekle (açılış ekranı kalkınca DOM'dan silinir)
            pg.wait_for_selector("#splash", state="detached", timeout=25000)
        except Exception as e:  # noqa: BLE001
            problem = "Açılış ekranı 25 saniyede kalkmadı (" + type(e).__name__ + ")."
        b.close()
    csp_errs = [e for e in errs if "Content Security Policy" in e]
    if csp_errs and not problem:
        problem = "Tarayıcı bir betiği engelledi (CSP)."
    if not problem:
        print("Site açılıyor.")
        return 0
    detail = "\n".join(errs[:5])
    print(problem + ("\n" + detail if detail else ""))
    notify(problem, detail)
    return 1


def notify(problem, detail):
    # Arka arkaya her saat mail gelmesin: bir önceki denetim de başarısızsa yeniden yazma
    if os.environ.get("PREV_CONCLUSION") == "failure":
        print("Önceki denetim de başarısızdı; mail tekrar gönderilmedi.")
        return
    from email.message import EmailMessage

    from remind import Mailer

    m = Mailer("--dry" in sys.argv)
    if not m.ok():
        print("GMAIL_USER / GMAIL_APP_PASSWORD yok; mail gönderilmedi.")
        return
    msg = EmailMessage()
    msg["Subject"] = "NBA Tahmin açılmıyor"
    msg["To"] = m.user
    run = os.environ.get("RUN_URL", "")
    msg.set_content(f"{problem}\n\n{detail}\n\nSite: {SITE}\n{('Ayrıntı: ' + run) if run else ''}\n\nBu maili sitenin saatlik açılış denetimi gönderdi.")
    m.send(msg)
    m.close()
    print("Uyarı maili gönderildi.")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "csp":
        sys.exit(check_csp("--fix" in sys.argv))
    if mode == "live":
        sys.exit(check_live())
    sys.exit(__doc__)

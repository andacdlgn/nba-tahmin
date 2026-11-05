"""Yönetim panelindeki "Herkesi sil" isteğini işler (reset.py her çalıştığında çağırır).

league/purge = {state: "pending", by: <yönetici uid>} görülünce yöneticiler (config/admin.uids) dışındaki
bütün oyuncuların Firebase Auth hesabını ve verisini siler; sohbeti tamamen temizler.
Sonuç: league/purge = {state: "done", n: silinen oyuncu sayısı, at} ya da {state: "error", err}.
Böylece silinenler aynı adla yeniden kayıt olabilir. Geri alınamaz.
"""
from firebase_admin import auth, firestore

# uid alanı taşıyan belgeler (uid yöneticiye aitse kalır)
BY_FIELD = ["picks", "daily", "progress", "lt", "series", "talk", "reports", "chat"]
# belge adı uid olanlar
BY_ID = ["players", "recovery", "contacts", "verifyReq", "otpStatus", "joins", "chatlim", "typing", "resetLocks", "resetCode"]
# tamamen temizlenenler
WIPE = ["chat", "typing", "banned"]


def _delete_all(refs):
    n = 0
    for r in refs:
        r.delete()
        n += 1
    return n


def delete_users(db, victims, wipe=False):
    """Verilen oyuncuların bütün verisini ve giriş hesabını siler. wipe: sohbet ve çıkarılanlar listesi tamamen temizlenir."""
    removed = {}
    for coll in BY_FIELD:
        refs = [d.reference for d in db.collection(coll).stream()
                if (d.to_dict() or {}).get("uid") in victims or any(d.id.endswith("_" + v) for v in victims)]
        removed[coll] = _delete_all(refs)
    for coll in BY_ID + ["deleteReq"]:
        removed[coll] = _delete_all([db.collection(coll).document(v) for v in victims
                                     if db.collection(coll).document(v).get().exists])
    # özel mesajlar: oyunculardan birinin silindiği konuşmalar mesajlarıyla birlikte gider
    n = 0
    for d in db.collection("dm").stream():
        if set((d.to_dict() or {}).get("u", [])) & set(victims):
            n += _delete_all([m.reference for m in d.reference.collection("m").stream()])
            d.reference.delete()
            n += 1
    removed["dm"] = n
    if wipe:
        for coll in WIPE:
            removed[coll] = _delete_all([d.reference for d in db.collection(coll).stream()])
        db.collection("chatpin").document("main").set({"id": ""})
    else:
        pin = db.collection("chatpin").document("main").get()
        if pin.exists and (pin.to_dict() or {}).get("uid") in victims:
            pin.reference.set({"id": ""})
    ids = sorted(victims)
    for i in range(0, len(ids), 1000):
        try:
            auth.delete_users(ids[i:i + 1000])
        except Exception as e:
            print("hesap silinemedi:", type(e).__name__)
    return removed


def run_self(db, admins):
    """Oyuncunun kendi isteği: deleteReq/{uid} → o oyuncunun hesabı ve verisi silinir (yönetici kendini bu yolla silemez)."""
    for r in db.collection("deleteReq").stream():
        uid = r.id
        if uid in admins:
            r.reference.delete()
            print("silme: yönetici kendini silemez")
            continue
        removed = delete_users(db, {uid})
        print("profil silindi:", uid[:5], removed)


def run(db):
    try:
        adm0 = db.collection("config").document("admin").get()
        run_self(db, set((adm0.to_dict() or {}).get("uids", [])) if adm0.exists else set())
    except Exception as e:
        print("profil silme hatası:", type(e).__name__)
    ref = db.collection("league").document("purge")
    snap = ref.get()
    req = snap.to_dict() if snap.exists else None
    if not req or req.get("state") != "pending":
        return
    adm = db.collection("config").document("admin").get()
    admins = set((adm.to_dict() or {}).get("uids", [])) if adm.exists else set()
    if not admins or req.get("by") not in admins:
        ref.set({"state": "error", "err": "istek yöneticiden gelmiyor", "at": firestore.SERVER_TIMESTAMP})
        print("silme: yetkisiz istek")
        return
    ref.set({"state": "running", "by": req.get("by"), "at": firestore.SERVER_TIMESTAMP})
    try:
        victims = set()
        for u in auth.list_users().iterate_all():
            if u.uid not in admins:
                victims.add(u.uid)
        for d in db.collection("players").stream():
            if d.id not in admins:
                victims.add(d.id)
        removed = delete_users(db, victims, wipe=True)
        ref.set({"state": "done", "n": len(victims), "at": firestore.SERVER_TIMESTAMP})
        print("silme tamam:", len(victims), "oyuncu", removed)
    except Exception as e:
        ref.set({"state": "error", "err": type(e).__name__, "at": firestore.SERVER_TIMESTAMP})
        print("silme hatası:", type(e).__name__, e)

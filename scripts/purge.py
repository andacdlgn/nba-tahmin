"""Yönetim panelindeki "Herkesi sil" isteğini işler (reset.py her çalıştığında çağırır).

league/purge = {state: "pending", by: <yönetici uid>} görülünce yöneticiler (config/admin.uids) dışındaki
bütün oyuncuların Firebase Auth hesabını ve verisini siler; sohbeti tamamen temizler.
Sonuç: league/purge = {state: "done", n: silinen oyuncu sayısı, at} ya da {state: "error", err}.
Böylece silinenler aynı adla yeniden kayıt olabilir. Geri alınamaz.
"""
from firebase_admin import auth, firestore

# uid alanı taşıyan belgeler (uid yöneticiye aitse kalır)
BY_FIELD = ["picks", "daily", "progress", "lt", "series", "talk", "reports"]
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


def run(db):
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
        removed = {}
        for coll in BY_FIELD:
            refs = [d.reference for d in db.collection(coll).stream()
                    if (d.to_dict() or {}).get("uid") in victims or any(d.id.endswith("_" + v) for v in victims)]
            removed[coll] = _delete_all(refs)
        for coll in BY_ID:
            removed[coll] = _delete_all([db.collection(coll).document(v) for v in victims
                                         if db.collection(coll).document(v).get().exists])
        for coll in WIPE:
            removed[coll] = _delete_all([d.reference for d in db.collection(coll).stream()])
        db.collection("chatpin").document("main").set({"id": ""})
        ids = sorted(victims)
        for i in range(0, len(ids), 1000):
            auth.delete_users(ids[i:i + 1000])
        ref.set({"state": "done", "n": len(ids), "at": firestore.SERVER_TIMESTAMP})
        print("silme tamam:", len(ids), "oyuncu", removed)
    except Exception as e:
        ref.set({"state": "error", "err": type(e).__name__, "at": firestore.SERVER_TIMESTAMP})
        print("silme hatası:", type(e).__name__, e)

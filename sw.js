// NBA Tahmin — servis çalışanı. Ana ekrana eklenebilmesi ve internet yokken son görülen halin açılması için.
// Her zaman önce ağdan alır (skorlar ve tahminler canlı kalsın); ağ yoksa son kaydedilen kopyayı verir.
// Yalnızca sitenin kendi dosyaları (sayfa, kod, stil, logolar, data/*.json) saklanır; Firebase ve ESPN istekleri saklanmaz.
const CACHE = "nbat-v1";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const c = await caches.open(CACHE);
        // aynı dosyanın ?v= sürümleri tek kayıtta tutulur
        c.put(url.pathname, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = await c.match(url.pathname) || (req.mode === "navigate" ? await c.match(new URL("./", location).pathname) : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

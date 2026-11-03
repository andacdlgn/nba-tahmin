// NBA Tahmin — servis çalışanı. Ana ekrana eklenebilmesi, hızlı açılış ve internet yokken son görülen halin açılması için.
// Yalnızca sitenin kendi dosyaları saklanır; Firebase, ESPN ve GitHub veri istekleri saklanmaz.
//
// Dosya türüne göre:
//  - Sürümlü dosyalar (app.js?v=…, style.css?v=…, i18n/…?v=…) ve logolar, simgeler: önce cihazdaki kopya (anında açılır),
//    yoksa internetten alınıp saklanır. Yeni sürümde adres (?v=) değiştiği için yeni dosya internetten gelir; eskisi silinir.
//  - Sayfanın kendisi (index.html): önce internet, 2,5 sn içinde gelmezse cihazdaki kopya.
//  - version.json ve data/*.json: hep internetten (güncel kalsın), yalnızca internet yoksa kopya.
const CACHE = "nbat-v2";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

const isStatic = url => url.searchParams.has("v") || /\/(logos|icons)\//.test(url.pathname) || /\.(png|svg|webp|woff2?)$/.test(url.pathname);

async function put(c, key, res) { if (res && res.ok && res.type === "basic") await c.put(key, res.clone()).catch(() => {}); return res; }

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    // 1) sürümlü ve değişmeyen dosyalar: önce cihaz
    if (isStatic(url)) {
      const hit = await c.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && url.searchParams.has("v")) {   // aynı dosyanın eski sürümlerini temizle
        for (const k of await c.keys()) { const u = new URL(k.url); if (u.pathname === url.pathname && u.search !== url.search) c.delete(k); }
      }
      return put(c, req.url, res);
    }
    // 2) sayfa: önce internet (en çok 2,5 sn), sonra kopya
    if (req.mode === "navigate") {
      const key = new URL("./", location).pathname;
      try {
        const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("yavaş")), 2500))]);
        return put(c, key, res);
      } catch (err) {
        const hit = await c.match(key);
        if (hit) { fetch(req).then(r => put(c, key, r)).catch(() => {}); return hit; }
        return fetch(req);
      }
    }
    // 3) diğerleri (version.json, data/*.json): önce internet, yoksa kopya
    try { return await put(c, url.pathname, await fetch(req)); }
    catch (err) { const hit = await c.match(url.pathname); if (hit) return hit; throw err; }
  })());
});

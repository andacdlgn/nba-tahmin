// NBA Tahmin — servis çalışanı KALDIRILDI (1.21.4).
// Önbellekten açılış mobilde (özellikle Safari'de) eski ve yeni dosyaların karışmasına, bazı bölümlerin yüklenmemesine yol açıyordu.
// Bu dosya telefonlarda kalmış eski servis çalışanını bulur: bütün önbelleği siler, kendini kaldırır ve sayfayı bir kez yeniler.
// Bundan sonra site doğrudan internetten (tarayıcının normal önbelleğiyle) açılır.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (err) {}
  try { await self.registration.unregister(); } catch (err) {}
  try { for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url); } catch (err) {}
})()));

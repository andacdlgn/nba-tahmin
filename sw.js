// NBA Tahmin — servis çalışanı. Sitenin "uygulama gibi" ana ekrana eklenebilmesi için.
// Bilerek hiçbir şeyi önbelleğe almaz: skorlar ve tahminler her zaman canlı gelir.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

/* global self, caches */
// Isletme paneli kaldirildi. Telefona "uygulama" olarak yuklenmis eski panelin service worker'i
// (kapsam /panel) bu dosyaya guncellenir: onbellegi siler, kendini kaldirir ve acik sayfayi
// yeniler; sayfa artik agdan gelir ve panelin kalktigini soyler (src/App.tsx). Yeni kayit yapilmaz.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: 'window' });
      await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => null)));
    })(),
  );
});

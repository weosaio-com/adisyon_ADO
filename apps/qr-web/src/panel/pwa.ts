// Isletme panelini yuklenebilir uygulama yapar. Manifest ve iOS etiketleri yalniz panel acilinca
// eklenir; service worker `/panel` kapsamiyla kaydedilir. Musteri menusu (/m/*) hic etkilenmez:
// musteriye "yukle" istemi cikmaz, menu her zaman ag uzerinden guncel gelir.
const HEAD_TAGS: Array<[tag: 'link' | 'meta', attrs: Record<string, string>]> = [
  ['link', { rel: 'manifest', href: '/panel.webmanifest' }],
  ['link', { rel: 'apple-touch-icon', href: '/icons/panel-180.png' }],
  ['meta', { name: 'apple-mobile-web-app-title', content: 'İşletme Paneli' }],
  ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
  ['meta', { name: 'mobile-web-app-capable', content: 'yes' }],
];

let ready = false;

export function setupPanelApp(): void {
  if (ready) return;
  ready = true;
  for (const [tag, attrs] of HEAD_TAGS) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    document.head.append(element);
  }
  // Gelistirme sunucusunda SW uretilmez; https (ya da localhost) disinda tarayici kaydetmez.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/panel' }).catch(() => {
      // Panel yine calisir; yalniz internet yokken acilamaz.
    });
  }
}

// Uygulama guncellemesinin acik tabletlere ulasmasi (OFF-7). Yeni surum yayinlaninca servis
// calisani (SW) arkada kurulur ve bekler; bekleyen gonderim ve yarim is yoksa sayfa
// kendiliginden yenilenir, varsa "Yeni sürüm hazır" seridi gosterilir. Acik tablet saatte bir
// ve sekme / uygulama one gelince guncelleme yoklar. Kayit tarayicinin yerel API'siyle yapilir
// (virtual:pwa-register ek paket ister); SW "SKIP_WAITING" mesajiyla etkinlesir (vite-plugin-pwa
// prompt kipi).
import { getState } from './engine';

const SW_URL = '/sw.js';
const CHECK_MS = 60 * 60 * 1000;
const SAFE_POLL_MS = 3_000;

let ready = false;
let applying = false;
let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}
export function subscribeUpdate(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function isUpdateReady(): boolean {
  return ready;
}

/**
 * Yenilemek guvenli mi: gonderilmeyi bekleyen islem yok, garson masa planinda (ya da giriste)
 * ve acik pencere (odeme, gerekce vb.) yok. Aksi halde yazilan / secilen kaybolabilir.
 */
export function safeToReload(): boolean {
  const sync = getState();
  if (sync.pending > 0 || sync.mode === 'syncing') return false;
  const path = window.location.pathname;
  if (path !== '/' && path !== '/login') return false;
  return document.querySelector('[role="dialog"]') === null;
}

/** Bekleyen yeni surumu etkinlestirir; yeni SW kontrolu alinca sayfa yenilenir. */
export function applyUpdate(): void {
  if (applying) return;
  applying = true;
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload(); // baska sekme etkinlestirdi: yalniz yenile
}

function markReady(worker: ServiceWorker | null) {
  waiting = worker;
  ready = true;
  emit();
  if (safeToReload()) applyUpdate();
}

export function startUpdates(): void {
  if (import.meta.env.DEV || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  const sw = navigator.serviceWorker;
  const hadController = sw.controller !== null;
  sw.addEventListener('controllerchange', () => {
    if (applying) window.location.reload();
    // Ilk kurulumda (onceki SW yokken) yenilemeye gerek yok; guncellemeyi baska sekme
    // etkinlestirdiyse bu sekme de guvenli anda yenilenir.
    else if (hadController) markReady(null);
  });
  sw.register(SW_URL, { scope: '/' })
    .then((registration) => {
      if (registration.waiting && sw.controller) markReady(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && sw.controller) markReady(worker);
        });
      });
      const check = () => {
        if (navigator.onLine === false) return;
        void registration.update().catch(() => {});
      };
      window.setInterval(check, CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('focus', check);
    })
    .catch(() => {
      // Guvensiz baglam (HTTP LAN adresi) / tarayici destegi yok: cevrimdisi kabuk olmaz.
    });
  // Yeni surum hazirken guvenli an gelince (or. garson masa planina donunce) yenilenir.
  window.setInterval(() => {
    if (ready && safeToReload()) applyUpdate();
  }, SAFE_POLL_MS);
}

import { useSyncExternalStore } from 'react';

// Baglanti durumu: tarayicinin online/offline olaylari + gercek istek sonuclari. "WiFi var ama
// internet yok" durumunu da yakalar. Dinleyen varken (panel) cevrimdisiyken /api/health'i aralikla
// yoklar; musteri sayfasi dinlemez, yoklama da yapilmaz.
const PROBE_MS = 10_000;

let online = typeof navigator === 'undefined' ? true : navigator.onLine;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next !== online) {
    online = next;
    listeners.forEach((listener) => listener());
  }
  if (!online) schedule();
}

function schedule(): void {
  if (timer || listeners.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    void probe();
  }, PROBE_MS);
}

/** Bulutu yoklar; sonucu durum olarak yayar. */
export async function probe(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    set(res.ok);
  } catch {
    set(false);
  }
  return online;
}

/** api() her yanitta (durum kodu ne olursa olsun) ve her ag hatasinda bildirir. */
export const reportReachable = () => set(true);
export const reportUnreachable = () => set(false);
export const isOnline = () => online;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!online) schedule();
  return () => {
    listeners.delete(listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void probe());
  window.addEventListener('offline', () => set(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !online && listeners.size > 0) void probe();
  });
}

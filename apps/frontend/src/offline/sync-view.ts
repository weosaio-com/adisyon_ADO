// Baglanti rozetinin saf gorunum karari. Self-check: sync-core.selfcheck.ts
import type { SyncState } from './engine';

export interface BadgeView {
  /** data-mode (e2e ve stil): online | offline | syncing | waiting | degraded */
  mode: string;
  text: string;
  cls: string;
}

/**
 * Rozet: baglanti ve gonderim durumu tek bakista. "Çevrimdışı" yalniz sunucuya ulasilamazken;
 * sunucu kabul etmeyen / onaya alan kayit varsa (sorun listesi) "Sorun var".
 */
export function badgeView(s: Pick<SyncState, 'mode' | 'problems'>): BadgeView {
  if (s.mode === 'offline') {
    return { mode: 'offline', text: 'Çevrimdışı', cls: 'bg-red-100 text-red-700' };
  }
  if (s.mode === 'syncing') {
    return { mode: 'syncing', text: 'Gönderiliyor', cls: 'bg-amber-100 text-amber-700' };
  }
  if (s.mode === 'waiting') {
    return { mode: 'waiting', text: 'Gönderim bekliyor', cls: 'bg-amber-100 text-amber-800' };
  }
  if (s.problems > 0) {
    return { mode: 'degraded', text: 'Sorun var', cls: 'bg-orange-100 text-orange-700' };
  }
  return { mode: 'online', text: 'Çevrimiçi', cls: 'bg-green-100 text-green-700' };
}

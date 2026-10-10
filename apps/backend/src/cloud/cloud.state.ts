import { createHash } from 'node:crypto';

/**
 * QR menu bulut baglantisinin durumu (saf fonksiyonlar; cloud.state.selfcheck.ts).
 * Kayit ApplicationSetting `cloud.state`'te durur; eski kayitlar withDefaults ile tamamlanir.
 */

/** Ayarlar kartinin gosterecegi durum. */
export type CloudMode =
  /** Bu kurulumda bulut adresi yok/gecersiz (derleme profili). */
  | 'unconfigured'
  /** Gecerli lisans girilmemis. */
  | 'no_license'
  /** Lisans QR menuyu icermiyor (ya da lisans numarasi yok). */
  | 'not_licensed'
  /** Lisansin suresi dolmus. */
  | 'expired'
  /** Acilabilir: "QR menuyu ac". */
  | 'off'
  /** Acma istendi ama internet yok; kendiliginden yeniden denenir. */
  | 'waiting_network'
  /** Lisans baska bir bilgisayarda acik; devralmak sahibin onayini ister. */
  | 'conflict'
  /** Baglanti bulutta gecersiz kilindi (lostReason). */
  | 'lost'
  /** Acik, yayinlaniyor. */
  | 'on'
  /** Acik ama bulut isletmeyi askiya almis. */
  | 'suspended';

export type LostReason = 'superseded' | 'rotated' | 'revoked' | 'unpaired' | 'invalid';
export type BlockedReason = 'suspended' | 'expired' | 'not_licensed';
/** Bulutta kapatilmayi bekleyen eski baglanti (adresi ve belirteci). */
export interface PendingUnpair {
  url: string;
  token: string;
}

export interface CloudState {
  lastPublishedAt: string | null;
  lastMenuVersion: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Son basarili yayinin kaynak ozeti (gereksiz yayin ve surum artisini onler). */
  lastPayloadHash: string | null;
  /** Son yayin denemesi basarisiz: uzlastirma yeniden dener. */
  lastAttemptFailed: boolean;
  /** Bulut yayini reddediyor (403); belirtec gecerli, durum duzelince devam edilir. */
  blocked: BlockedReason | null;
  /** Baglanti bulutta gecersiz kilindi (401). */
  lost: { reason: LostReason; at: string } | null;
  /** Acma denemesinde lisans baska kurulumda acikti (409). */
  conflict: { lastSeenAt: string | null; at: string } | null;
  /** Internet yokken istenen acma; uzlastirma yeniden dener. */
  activationPending: { takeover: boolean; at: string } | null;
  /**
   * Internet yokken kapatilan ya da dusurulen baglantilar (adres degisti, farkli lisans): bulutta da
   * kapatilana kadar denenir. Yeni acmadan once kapatilir (masa kodlari eski subede kalmasin).
   */
  pendingUnpairs: PendingUnpair[];
  /** Yeni lisans buluta bildirilecek (yenileme). */
  licenseSyncPending: boolean;
  /** Son durum sorgusu (paket/askiya alma/lisans bitisi). */
  lastStatusAt: string | null;
}

export const EMPTY_STATE: CloudState = {
  lastPublishedAt: null,
  lastMenuVersion: null,
  lastError: null,
  lastErrorAt: null,
  lastPayloadHash: null,
  lastAttemptFailed: false,
  blocked: null,
  lost: null,
  conflict: null,
  activationPending: null,
  pendingUnpairs: [],
  licenseSyncPending: false,
  lastStatusAt: null,
};

export function withDefaults(raw: Partial<CloudState> | null | undefined): CloudState {
  return { ...EMPTY_STATE, ...(raw ?? {}) };
}

/** Bekleyen kapatmalara ekler (ayni belirtec bir kez). */
export function withPendingUnpair(list: PendingUnpair[], auth: PendingUnpair): PendingUnpair[] {
  return [
    ...list.filter((item) => item.token !== auth.token),
    { url: auth.url, token: auth.token },
  ];
}

export type CloudErrorKind =
  | { kind: 'lost'; reason: LostReason }
  | { kind: 'blocked'; reason: BlockedReason }
  | { kind: 'conflict' }
  /** Gecici: internet yok, bulut bakimda ya da cok fazla deneme. Sonra yeniden denenir. */
  | { kind: 'network' }
  | { kind: 'other' };

const LOST: Record<string, LostReason> = {
  POS_TOKEN_SUPERSEDED: 'superseded',
  POS_TOKEN_ROTATED: 'rotated',
  POS_TOKEN_REVOKED: 'revoked',
  POS_TOKEN_UNPAIRED: 'unpaired',
};
const BLOCKED: Record<string, BlockedReason> = {
  TENANT_SUSPENDED: 'suspended',
  LICENSE_EXPIRED: 'expired',
  QR_MENU_NOT_LICENSED: 'not_licensed',
};

/** Bulut hatasinin POS'taki anlami (`status` 0 = buluta ulasilamadi). */
export function classifyCloudError(status: number, code: string): CloudErrorKind {
  if (status === 401) return { kind: 'lost', reason: LOST[code] ?? 'invalid' };
  const blocked = BLOCKED[code];
  if (status === 403 && blocked) return { kind: 'blocked', reason: blocked };
  if (status === 409 && code === 'ACTIVE_ON_OTHER_INSTALL') return { kind: 'conflict' };
  // Bulutta lisansla baglanma kapali: beklemek duzeltmez.
  if (code === 'ACTIVATION_DISABLED') return { kind: 'other' };
  if (status === 0 || status === 429 || status >= 500) return { kind: 'network' };
  return { kind: 'other' };
}

export interface ModeInput {
  configured: boolean;
  license: { id: string | null; qrMenu: boolean; expired: boolean } | null;
  connected: boolean;
  state: CloudState;
}

export function cloudMode({ configured, license, connected, state }: ModeInput): CloudMode {
  if (!configured) return 'unconfigured';
  if (connected) {
    if (state.blocked === 'suspended') return 'suspended';
    if (state.blocked === 'expired') return 'expired';
    if (state.blocked === 'not_licensed') return 'not_licensed';
    return 'on';
  }
  if (!license) return 'no_license';
  if (!license.id || !license.qrMenu) return 'not_licensed';
  if (license.expired) return 'expired';
  if (state.activationPending) return 'waiting_network';
  if (state.conflict) return 'conflict';
  if (state.lost) return 'lost';
  return 'off';
}

/** Buluttan gelen isletme durumuna gore yayin engeli. */
export function blockedFromStatus(
  tenant: { status: string; features: Record<string, boolean> },
  licenseExpiresAt: string | null,
  now = new Date(),
): BlockedReason | null {
  if (tenant.status === 'suspended') return 'suspended';
  if (licenseExpiresAt && licenseExpiresAt <= now.toISOString()) return 'expired';
  return tenant.features['qr.menu'] === true ? null : 'not_licensed';
}

/** Durum sorgusu zamani geldi mi. */
export function statusDue(lastStatusAt: string | null, now = new Date(), everySeconds = 3600) {
  return !lastStatusAt || now.getTime() - Date.parse(lastStatusAt) >= everySeconds * 1000;
}

/** Yayin kaynaginin ozeti (menu + masa listesi; olusturucu siralamayi sabit tutar). */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

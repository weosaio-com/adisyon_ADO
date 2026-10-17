import { createHash } from 'node:crypto';
import {
  heartbeatRequestSchema,
  type HeartbeatRequest,
  type LicenseRemoteState,
} from '@ado/shared';
import type { PosInfo } from './cloud.client';

/**
 * Bulut baglantisinin ve QR menu yayininin durumu (saf fonksiyonlar; cloud.state.selfcheck.ts).
 * Kayit ApplicationSetting `cloud.state`'te durur; eski kayitlar withDefaults ile tamamlanir.
 *
 * Iki ayri eksen var:
 * - Baglanti (CloudLinkMode): lisansli her kurulum buluta kendiliginden baglanir; heartbeat,
 *   lisans yenilemesi, uzaktan askiya alma/iptal bu baglantiyla gelir. Lisans karti gosterir.
 * - QR menu (CloudQrMode): baglantinin uzerinde, sahibin ac/kapat ayari (`cloud.qrPublish`).
 *   QR menu karti gosterir.
 */

/** Lisans kartindaki bulut satiri. */
export type CloudLinkMode =
  /** Bu kurulumda bulut adresi yok/gecersiz (derleme profili): satir gorunmez. */
  | 'unconfigured'
  /** Gecerli lisans girilmemis. */
  | 'no_license'
  /** Lisans numarasi (id) olmayan eski lisans: buluta baglanamaz. */
  | 'legacy_license'
  /** Baglanilacak (acilis, yeni lisans); birazdan denenir. */
  | 'linking'
  /** Son deneme internete takildi; kendiliginden yeniden denenir. */
  | 'waiting_network'
  /** Lisans baska bilgisayarda bagli; "Bu bilgisayara al" sahibin onayini ister. */
  | 'conflict'
  /** Satici bu bilgisayarin baglantisini kaldirdi; sahibin onayiyla yeniden baglanir. */
  | 'lost'
  /** Bulut baglanmayi reddetti (or. lisans anahtari tanimiyor); seyrek yeniden denenir. */
  | 'error'
  /** Bagli. */
  | 'linked'
  /** Satici isletmeyi askiya almis (bagliyken ya da baglanirken). */
  | 'suspended'
  /** Bagli; buluta gore lisansin suresi dolmus. */
  | 'expired'
  /** Lisans satici tarafindan iptal edilmis. */
  | 'revoked';

/** QR menu karti: kapali, acik ya da lisans QR menuyu icermiyor. */
export type CloudQrMode = 'off' | 'on' | 'not_licensed';

export type LostReason = 'superseded' | 'rotated' | 'revoked' | 'unpaired' | 'invalid';
/** Bulut QR yayinini neden reddediyor (belirtec gecerli; durum duzelince devam edilir). */
export type BlockedReason = 'suspended' | 'expired' | 'not_licensed' | 'revoked';
/** Bulutta kapatilmayi bekleyen eski baglanti (adresi ve belirteci). */
export interface PendingUnpair {
  url: string;
  token: string;
}

export interface CloudState {
  // --- QR yayini ---
  lastPublishedAt: string | null;
  lastMenuVersion: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Son basarili yayinin kaynak ozeti (gereksiz yayin ve surum artisini onler). */
  lastPayloadHash: string | null;
  /** Son yayin denemesi basarisiz: uzlastirma yeniden dener. */
  lastAttemptFailed: boolean;
  /** Bulut yayini reddediyor (403 ya da heartbeat'ten); belirtec gecerli. */
  blocked: BlockedReason | null;
  /** QR menu internetsizken kapatildi: bulutta menu ve masalar kaldirilacak. */
  unpublishPending: boolean;
  // --- Baglanti ---
  /** Baglanti bulutta gecersiz kilindi (401). */
  lost: { reason: LostReason; at: string } | null;
  /** Lisans baska kurulumda bagli (409 ya da devralindi): sahibin onayi beklenir. */
  conflict: { lastSeenAt: string | null; at: string } | null;
  /** Baglanma internete takildi; uzlastirma yeniden dener (takeover: sahip devralma istedi). */
  activationPending: { takeover: boolean; at: string } | null;
  /** Bulut baglanmayi reddetti (iptal, anahtar uyusmazligi...): heartbeat araliginda yeniden. */
  linkError: { code: string; message: string; at: string } | null;
  /**
   * Internet yokken dusurulen eski baglantilar (adres degisti, farkli lisans): bulutta da
   * kapatilana kadar denenir. Yeni baglanmadan once kapatilir (masa kodlari eski subede kalmasin).
   */
  pendingUnpairs: PendingUnpair[];
  /** Yeni lisans buluta bildirilecek (yenileme; yukseltmede bir kez). */
  licenseSyncPending: boolean;
  /** Son heartbeat denemesi (bulut yanit verdi; zamanlama icin). */
  lastHeartbeatAt: string | null;
  /** Bulutla son basarili temas (kartta "son gorulme"). */
  lastSeenAt: string | null;
  /** Bulutun son bildirdigi lisans durumu. */
  remoteState: LicenseRemoteState | null;
}

export const EMPTY_STATE: CloudState = {
  lastPublishedAt: null,
  lastMenuVersion: null,
  lastError: null,
  lastErrorAt: null,
  lastPayloadHash: null,
  lastAttemptFailed: false,
  blocked: null,
  unpublishPending: false,
  lost: null,
  conflict: null,
  activationPending: null,
  linkError: null,
  pendingUnpairs: [],
  licenseSyncPending: false,
  lastHeartbeatAt: null,
  lastSeenAt: null,
  remoteState: null,
};

/** Eski kayit eksik alanlarla tamamlanir; artik kullanilmayan alanlar (or. lastStatusAt) atilir. */
export function withDefaults(raw: Partial<CloudState> | null | undefined): CloudState {
  const state: Record<string, unknown> = { ...EMPTY_STATE };
  for (const key of Object.keys(EMPTY_STATE)) {
    const value = (raw as Record<string, unknown> | null | undefined)?.[key];
    if (value !== undefined) state[key] = value;
  }
  return state as unknown as CloudState;
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
  /** Bulutta bu uc yok (Worker henuz yeni surume gecmedi): eski uca dusulur. */
  | { kind: 'unsupported' }
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
  LICENSE_REVOKED: 'revoked',
};

/** Bulut hatasinin POS'taki anlami (`status` 0 = buluta ulasilamadi). */
export function classifyCloudError(status: number, code: string): CloudErrorKind {
  if (status === 401) return { kind: 'lost', reason: LOST[code] ?? 'invalid' };
  const blocked = BLOCKED[code];
  if (status === 403 && blocked) return { kind: 'blocked', reason: blocked };
  if (status === 409 && code === 'ACTIVE_ON_OTHER_INSTALL') return { kind: 'conflict' };
  // Ayni anda iki baglanma denemesi: kisa sure sonra yeniden denenir.
  if (status === 409 && code === 'ACTIVATION_CONFLICT') return { kind: 'network' };
  if (status === 404) return { kind: 'unsupported' };
  // Bulutta lisansla baglanma kapali: beklemek duzeltmez.
  if (code === 'ACTIVATION_DISABLED') return { kind: 'other' };
  if (status === 0 || status === 429 || status >= 500) return { kind: 'network' };
  return { kind: 'other' };
}

/**
 * Sahibin onayini bekleyen kayiplar: baska bilgisayar devraldi (geri almak "Bu bilgisayara al"),
 * satici baglantiyi kaldirdi. Bunlarda kendiliginden yeniden baglanilmaz; digerlerinde
 * (yenilendi, kapatildi, gecersiz) baglanilir.
 */
const HELD_LOST: ReadonlySet<LostReason> = new Set<LostReason>(['superseded', 'revoked']);

/**
 * Kendiliginden baglanma (acilis, uzlastirma, yeni lisans) yapilabilir mi. Bulutun reddi
 * (`linkError`) varsa `retrySeconds`'ta bir yeniden denenir; internet hatasi her turda denenir.
 */
export function autoLinkAllowed(state: CloudState, now = new Date(), retrySeconds = 3600): boolean {
  if (state.conflict) return false;
  if (state.lost && HELD_LOST.has(state.lost.reason)) return false;
  if (state.linkError) return statusDue(state.linkError.at, now, retrySeconds);
  return true;
}

export interface LinkInput {
  configured: boolean;
  license: { id: string | null } | null;
  connected: boolean;
  state: CloudState;
}

export function linkMode({ configured, license, connected, state }: LinkInput): CloudLinkMode {
  if (!configured) return 'unconfigured';
  if (connected) {
    // Bagliyken bulutun karari (heartbeat ya da yayin reddi) gecerlidir.
    const remote = state.remoteState;
    if (remote === 'revoked' || state.blocked === 'revoked') return 'revoked';
    if (remote === 'suspended' || state.blocked === 'suspended') return 'suspended';
    if (remote === 'expired' || state.blocked === 'expired') return 'expired';
    return 'linked';
  }
  if (!license) return 'no_license';
  if (!license.id) return 'legacy_license';
  if (state.conflict) return 'conflict';
  if (state.lost && HELD_LOST.has(state.lost.reason)) return 'lost';
  if (state.linkError?.code === 'LICENSE_REVOKED') return 'revoked';
  if (state.linkError?.code === 'TENANT_SUSPENDED') return 'suspended';
  if (state.linkError) return 'error';
  if (state.activationPending) return 'waiting_network';
  return 'linking';
}

export interface QrInput {
  qrPublish: boolean;
  license: { id: string | null; qrMenu: boolean } | null;
  connected: boolean;
  state: CloudState;
}

/**
 * QR menu karti. Lisans (yerel) QR menuyu icermiyorsa ya da bulut QR menu hakki olmadigini
 * soyluyorsa `not_licensed`; degilse ayar ne diyorsa.
 */
export function qrMode({ qrPublish, license, connected, state }: QrInput): CloudQrMode {
  if (!license?.id || !license.qrMenu) return 'not_licensed';
  if (connected && state.blocked === 'not_licensed') return 'not_licensed';
  return qrPublish ? 'on' : 'off';
}

/** Buluttan gelen isletme durumuna (ve varsa uzak lisans durumuna) gore yayin engeli. */
export function blockedFromStatus(
  tenant: { status: string; features: Record<string, boolean> },
  licenseExpiresAt: string | null,
  remote: LicenseRemoteState | null = null,
  now = new Date(),
): BlockedReason | null {
  if (remote === 'revoked') return 'revoked';
  if (tenant.status === 'suspended') return 'suspended';
  if (licenseExpiresAt && licenseExpiresAt <= now.toISOString()) return 'expired';
  return tenant.features['qr.menu'] === true ? null : 'not_licensed';
}

/**
 * Heartbeat yokken (baglanma yaniti, eski bulutun /status'u) isletme bilgisinden uzak durum.
 * Iptal yalniz heartbeat'le ogrenilir.
 */
export function remoteFromInfo(
  tenant: { status: string },
  licenseExpiresAt: string | null,
  now = new Date(),
): LicenseRemoteState {
  if (tenant.status === 'suspended') return 'suspended';
  if (licenseExpiresAt && licenseExpiresAt <= now.toISOString()) return 'expired';
  return 'active';
}

/** Zamani geldi mi (`last` yoksa evet). */
export function statusDue(lastStatusAt: string | null, now = new Date(), everySeconds = 3600) {
  return !lastStatusAt || now.getTime() - Date.parse(lastStatusAt) >= everySeconds * 1000;
}

/**
 * Bulut yanitindan (baglanma, heartbeat, durum, lisans yenileme) baglanti kaydina yazilan alanlar.
 * Ozellik haritasi OLDUGU GIBI saklanir (or. `cloud.backup`): bulut yedegi `currentLink().features`
 * ile buna bakar; bilinmeyen anahtar atilmaz.
 */
export function connectionInfo(info: PosInfo) {
  return {
    branchId: info.branch.id,
    branchName: info.branch.name,
    tenantName: info.tenant.name,
    tenantStatus: info.tenant.status,
    planLabel: info.tenant.planLabel,
    features: { ...info.tenant.features },
    licenseExpiresAt: info.license?.expiresAt ?? null,
  };
}

/** Yayin kaynaginin ozeti (menu + masa listesi; olusturucu siralamayi sabit tutar). */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Heartbeat govdesi: sozlesmeye (@ado/shared cloud-api) uymayan alan null gider; bulut tek bir
 * bozuk degerden (or. kesirli bayt, BigInt, Date) dolayi tum heartbeat'i 422 ile reddetmesin.
 */
export function heartbeatBody(raw: { [K in keyof HeartbeatRequest]?: unknown }): HeartbeatRequest {
  const shape = heartbeatRequestSchema.shape;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as Array<keyof HeartbeatRequest>) {
    let value = raw[key];
    if (typeof value === 'bigint') value = Number(value);
    if (typeof value === 'number' && Number.isFinite(value)) value = Math.round(value);
    if (value instanceof Date) value = Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value === '' || value === undefined) value = null;
    const parsed = shape[key].safeParse(value);
    out[key] = parsed.success ? parsed.data : null;
  }
  return out as HeartbeatRequest;
}

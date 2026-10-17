import { decodeTime } from 'ulid';
import type { LicenseRemoteState } from '@ado/shared';

// Lisans politikasi (saf): lisans / deneme / ek sure / bulut durumu ve "etkin saat" -> evre + kilit.
// I/O yok; saat, ayarlar ve kayitli durum disaridan gelir (LicenseService okur ve yazar).
// Kurallar (LICENSING.md §8):
//   - Lisans yok: deneme suresi (trialDays, varsayilan 0) bitince satis yok -> "unlicensed".
//   - Lisans var: bitisten 14 gun once uyari ("expiring"); bitince ek sure ("grace": lisanstaki
//     `g`, yoksa graceDays); ek sure de bitince yeni adisyon acilmaz ("locked").
//   - Bulut askiya aldi / iptal etti: ILK bildirimden itibaren graceDays ek sure, sonra kilit.
//     Ayni kimlikle bulut yeniden "active" derse (or. yenileme sonrasi) kisit kalkar.
//   - Zorunluluk kapali: hicbir sey kilitlenmez; serit yalniz bilgi verir.
//   - Kilit yalniz YENI adisyonu durdurur: acik adisyon odenir/kapanir; rapor, yedek, ayar,
//     katalog, kullanici, lisans girisi ve guncelleme hep aciktir.

export const DAY_MS = 86_400_000;
/** Bitisten kac gun once uyari baslar. */
export const EXPIRY_WARNING_DAYS = 14;
/**
 * Cevrimdisi islem (tablet outbox) kilitten once olusturulduysa gecer. Istemci saati guvenilmez:
 * sahte eski zaman en fazla bu kadar ise yarar (bir vardiya + pay; garson oturumu 12 saat).
 */
export const OFFLINE_OP_MAX_AGE_MS = 24 * 3_600_000;
/** Kalici saat isareti en fazla bu aralikla yazilir (her durum okumasinda yazilmaz). */
export const CLOCK_WRITE_INTERVAL_MS = 10 * 60_000;
/** Yerel isaret bulut saatinin bu kadar ilerisindeyse saat bir ara ileri kaymis demektir. */
export const CLOCK_SERVER_CORRECTION_MS = DAY_MS;

export type LicensePhase = 'trial' | 'unlicensed' | 'active' | 'expiring' | 'grace' | 'locked';
/** Kisitin (ya da yaklasan kilidin) nedeni. Sorun yoksa null. */
export type LicenseReason = 'no_license' | 'expired' | 'suspended' | 'revoked';
export type BannerLevel = 'info' | 'warning' | 'danger';

export interface PolicyLicense {
  /** Lisans kimligi (eski lisanslarda yok). Bulut durumu yalniz ayni kimlige uygulanir. */
  id: string | null;
  /** exp: yerel gun basi (licenseDates). */
  validUntil: Date;
  /** Lisanstaki `g` (gun). Yoksa graceDays kullanilir. */
  graceDays?: number | undefined;
}

export interface PolicyRemote {
  licenseId: string;
  state: LicenseRemoteState;
  /** Askiya alma / iptalin ILK alindigi an (yalniz suspended | revoked). */
  since: Date | null;
}

export interface PolicyInput {
  /** Etkin saat: max(sistem saati, saat isareti) — bkz. effectiveNowMs. */
  now: Date;
  enforced: boolean;
  license: PolicyLicense | null;
  /** Deneme baslangici (kurulum dosyasi ve ayardaki anlarin en erkeni). */
  trialStartedAt: Date;
  trialDays: number;
  /** Profildeki ek sure (gun): lisansta `g` yoksa ve bulut kisitinda kullanilir. */
  graceDays: number;
  remote: PolicyRemote | null;
}

export interface PolicyBanner {
  level: BannerLevel;
  /** Ilgili ana kalan gun (bitis ya da kilit); kilitliyse 0. */
  daysLeft: number | null;
  /** Ilgili an: deneme sonu, lisans bitisi ya da kilit ani. */
  until: Date | null;
}

export interface PolicyResult {
  phase: LicensePhase;
  /** Yeni adisyon durdu mu (yalniz zorunluluk aciksa true olabilir). */
  locked: boolean;
  /** trial: deneme sonuna; active/expiring: bitise; grace: kilide kalan gun; kilitliyse 0. */
  daysLeft: number | null;
  /** Yeni adisyonun durdugu (duracagi) an. */
  lockAt: Date | null;
  reason: LicenseReason | null;
  /** Gosterilecek serit; soylenecek bir sey yoksa null. */
  banner: PolicyBanner | null;
  /** Lisans yokken deneme sonu; lisans varken null. */
  trialEndsAt: Date | null;
  /** Lisansin kendi ek suresinin sonu (exp + g/graceDays); lisans yoksa null. */
  graceUntil: Date | null;
  /** Bu lisansa uygulanan bulut durumu (ayni kimlik); yoksa null. */
  remoteState: LicenseRemoteState | null;
}

/** Yerel takvim gunu ekler (yaz saatinde saat kaymaz; licenseDates ile ayni kural). */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Kalan gun, yukari yuvarlanir: bugun bitiyorsa 1, gectiyse 0 ya da eksi. */
export function daysUntil(target: Date, now: Date): number {
  return Math.ceil((target.getTime() - now.getTime()) / DAY_MS);
}

/** Lisanstaki `g` onceliklidir; yoksa profildeki ek sure. */
export function effectiveGraceDays(license: Pick<PolicyLicense, 'graceDays'>, graceDays: number) {
  return Math.max(0, license.graceDays ?? graceDays);
}

function isRestricted(state: LicenseRemoteState): state is 'suspended' | 'revoked' {
  return state === 'suspended' || state === 'revoked';
}

export function evaluateLicensePolicy(input: PolicyInput): PolicyResult {
  const { now, enforced, license } = input;

  if (!license) {
    const trialEndsAt = addDays(input.trialStartedAt, Math.max(0, input.trialDays));
    const inTrial = now.getTime() < trialEndsAt.getTime();
    const daysLeft = inTrial ? daysUntil(trialEndsAt, now) : 0;
    return {
      phase: inTrial ? 'trial' : 'unlicensed',
      locked: enforced && !inTrial,
      daysLeft,
      lockAt: trialEndsAt,
      reason: inTrial ? null : 'no_license',
      // Zorunluluk kapaliyken lisanssiz calismak normaldir: soylenecek bir sey yok.
      banner: enforced
        ? { level: inTrial ? 'info' : 'danger', daysLeft, until: trialEndsAt }
        : null,
      trialEndsAt,
      graceUntil: null,
      remoteState: null,
    };
  }

  const graceUntil = addDays(license.validUntil, effectiveGraceDays(license, input.graceDays));
  // Bulut durumu yalniz AYNI kimlikli lisansa uygulanir (lisans degistiyse eski bildirim gecersiz).
  const remote =
    input.remote && license.id !== null && input.remote.licenseId === license.id
      ? input.remote
      : null;
  const restriction = remote && isRestricted(remote.state) ? remote.state : null;
  const remoteLockAt =
    remote && restriction ? addDays(remote.since ?? now, Math.max(0, input.graceDays)) : null;
  const lockAt =
    remoteLockAt && remoteLockAt.getTime() < graceUntil.getTime() ? remoteLockAt : graceUntil;

  let phase: LicensePhase;
  let reason: LicenseReason | null = null;
  if (now.getTime() >= lockAt.getTime()) {
    phase = 'locked';
    // Bulut kisiti varsa o soylenir: yalniz yenilemek yetmez, saticiyla gorusmek gerekir.
    reason = restriction ?? 'expired';
  } else if (restriction) {
    phase = 'grace';
    reason = restriction;
  } else if (now.getTime() >= license.validUntil.getTime()) {
    phase = 'grace';
    reason = 'expired';
  } else if (daysUntil(license.validUntil, now) <= EXPIRY_WARNING_DAYS) {
    phase = 'expiring';
  } else {
    phase = 'active';
  }

  const toExpiry = phase === 'active' || phase === 'expiring';
  const daysLeft = phase === 'locked' ? 0 : daysUntil(toExpiry ? license.validUntil : lockAt, now);
  const until = toExpiry ? license.validUntil : lockAt;
  const banner: PolicyBanner | null =
    phase === 'active'
      ? null
      : {
          // Zorunluluk kapaliyken yalniz bilgi: hicbir sey durmayacak.
          level: !enforced ? 'info' : phase === 'expiring' ? 'warning' : 'danger',
          daysLeft,
          until,
        };

  return {
    phase,
    locked: enforced && phase === 'locked',
    daysLeft,
    lockAt,
    reason,
    banner,
    trialEndsAt: null,
    graceUntil,
    remoteState: remote?.state ?? null,
  };
}

/**
 * Yeni adisyon acilabilir mi. Kilitliyken yalniz kilitten ONCE (tablette, cevrimdisi)
 * olusturulmus islem gecer; o da en fazla OFFLINE_OP_MAX_AGE_MS eskiyse (istemci saati
 * guvenilmez, sahte eski zaman en fazla bu kadar ise yarar).
 */
export function canOpenOrder(
  result: Pick<PolicyResult, 'locked' | 'lockAt'>,
  now: Date,
  offlineCreatedAt?: Date | null,
): boolean {
  if (!result.locked) return true;
  if (!offlineCreatedAt || !result.lockAt) return false;
  const createdAt = offlineCreatedAt.getTime();
  return createdAt < result.lockAt.getTime() && createdAt >= now.getTime() - OFFLINE_OP_MAX_AGE_MS;
}

// Crockford base32, 26 karakter; ilk karakter 0-7 (48 bit zaman). decodeTime yalniz zaman
// kismina baktigi icin bicim burada butunuyle denetlenir.
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Istemcinin urettigi clientOpId (ULID) icindeki olusma ani; ULID degilse null. */
export function clientOpTime(clientOpId: string | null | undefined): Date | null {
  if (!clientOpId || !ULID_PATTERN.test(clientOpId)) return null;
  try {
    return new Date(decodeTime(clientOpId));
  } catch {
    return null;
  }
}

// --- Etkin saat (saat geri alinmasina karsi) ----------------------------------------------

/** Bu surecte en son gorulen etkin saat ve o anki monoton saat (performance.now). */
export interface ClockMemo {
  at: number;
  mono: number;
}

/**
 * Etkin saat: sistem saati, kalici isaret (license.clock) ve surec icinde MONOTON saatle
 * ilerletilen son deger icinden en gec olani. Saat geri alinsa da sure akmaya devam eder:
 * surec icinde gecen sure duvar saatinden degil monoton saatten gelir.
 */
export function effectiveNowMs(
  systemNow: number,
  persisted: number | null,
  memo: ClockMemo | null,
  monoNow: number,
): number {
  let now = systemNow;
  if (persisted !== null && persisted > now) now = persisted;
  if (memo) {
    const projected = memo.at + Math.max(0, monoNow - memo.mono);
    if (projected > now) now = projected;
  }
  return now;
}

/** Kalici isaret yeniden yazilmali mi: yoksa ya da etkin saat en az 10 dk ilerlediyse. */
export function shouldPersistClock(persisted: number | null, now: number): boolean {
  return persisted === null || now - persisted >= CLOCK_WRITE_INTERVAL_MS;
}

/**
 * Bulut saati (license.remote.serverTime) geldiginde yeni kalici isaret. Ileri gidiyorsa alinir;
 * yerel isaret bulutun bir gunden fazla ilerisindeyse (bilgisayarin saati bir ara ileri
 * alinmis) bulut saatine indirilir — guvenilir kaynak buluttur. Degisiklik yoksa null.
 */
export function clockFromServer(persisted: number | null, serverTime: number): number | null {
  if (persisted === null || serverTime > persisted) return serverTime;
  if (persisted - serverTime > CLOCK_SERVER_CORRECTION_MS) return serverTime;
  return null;
}

/** Verilen anlarin en erkeni (deneme baslangici: kurulum dosyasi ve ayar; biri silinse de sifirlanmaz). */
export function earliestDate(...dates: Array<Date | null | undefined>): Date | null {
  let earliest: Date | null = null;
  for (const date of dates) {
    if (!date || Number.isNaN(date.getTime())) continue;
    if (!earliest || date.getTime() < earliest.getTime()) earliest = date;
  }
  return earliest;
}

// --- Bulut bildirimi ---------------------------------------------------------------------

/** `license.remote` ayarinda saklanan son bulut durumu. */
export interface StoredRemoteState {
  licenseId: string;
  state: LicenseRemoteState;
  /** Askiya alma / iptalin ILK alindigi an (ISO); kisit yoksa null. */
  since: string | null;
  receivedAt: string;
  serverTime: string;
}

/**
 * Yeni bulut bildirimini kayitli durumla birlestirir. Heartbeat saatte bir ayni durumu tekrarlar:
 * ek sure HER bildirimde degil, ayni lisansin kisiti ILK bildirildiginde baslar.
 */
export function mergeRemoteState(
  prev: StoredRemoteState | null,
  incoming: Omit<StoredRemoteState, 'since'>,
  now: Date,
): StoredRemoteState {
  let since: string | null = null;
  if (isRestricted(incoming.state)) {
    const continuing =
      prev !== null &&
      prev.licenseId === incoming.licenseId &&
      isRestricted(prev.state) &&
      prev.since !== null;
    since = continuing ? prev.since : now.toISOString();
  }
  return { ...incoming, since };
}

/**
 * Buluttan gelen imzali yenileme kurulmali mi: kurulu lisansla AYNI kimlik (bildirimin kimligi
 * de ayni) ve daha gec etkin bitis (ek sure dahil). Imza ve sure ayrica dogrulanir.
 */
export function acceptsRemoteUpdate(
  current: { id: string | null; graceUntil: Date } | null,
  update: { id: string | null; graceUntil: Date },
  eventLicenseId: string,
): boolean {
  if (!current?.id || current.id !== eventLicenseId || update.id !== current.id) return false;
  return update.graceUntil.getTime() > current.graceUntil.getTime();
}

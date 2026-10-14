// Lisans durumunun gosterimi: uyari seridi, kilit penceresi ve Ayarlar > Lisans karti ayni
// metinleri kullanir. Saf (import yok); self-check: license-notice.selfcheck.ts.
// Sozlesme: GET /license (backend LicenseService.getStatus). Politika: LICENSING.md §8.

export type LicensePhase = 'trial' | 'unlicensed' | 'active' | 'expiring' | 'grace' | 'locked';
export type LicenseReason = 'no_license' | 'expired' | 'suspended' | 'revoked';
export type BannerLevel = 'info' | 'warning' | 'danger';

export interface LicenseStatus {
  enforced: boolean;
  state: 'none' | 'active' | 'grace' | 'expired';
  customerName: string | null;
  plan: string | null;
  validUntil: string | null;
  graceUntil: string | null;
  daysLeft: number | null;
  verifiable: boolean;
  licenseId: string | null;
  features: Record<string, boolean>;
  needsReentry: boolean;
  phase: LicensePhase;
  locked: boolean;
  lockAt: string | null;
  trialEndsAt: string | null;
  remoteState: 'active' | 'suspended' | 'revoked' | 'expired' | null;
  reason: LicenseReason | null;
  graceDays: number;
  banner: { level: BannerLevel; daysLeft: number | null; until: string | null } | null;
  supportContact: string | null;
}

export interface NoticeContent {
  level: BannerLevel;
  text: string;
  /** Seritteki dugmenin etiketi (lisans penceresini acar). */
  action: string;
}

const dayFormat = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });

/** "8 Haziran 2027" (gece yarisiysa) ya da "8 Haziran 2027 14:30". */
export function formatMoment(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = dayFormat.format(date);
  return date.getHours() === 0 && date.getMinutes() === 0
    ? day
    : `${day} ${timeFormat.format(date)}`;
}

const isRemoteRestriction = (reason: LicenseReason | null) =>
  reason === 'suspended' || reason === 'revoked';

function remoteText(reason: LicenseReason | null): string {
  return reason === 'suspended' ? 'Lisansınız askıya alındı' : 'Lisansınız iptal edildi';
}

/** Uyari seridi; soylenecek bir sey yoksa null (zorunluluk kapali ve lisans yoksa da null). */
export function bannerContent(s: LicenseStatus): NoticeContent | null {
  const banner = s.banner;
  if (!banner) return null;
  const days = banner.daysLeft ?? 0;
  const when = formatMoment(banner.until);
  const restricted = isRemoteRestriction(s.reason);

  if (!s.enforced) {
    // Zorunluluk kapali: yalniz bilgi, hicbir sey durmaz.
    const text =
      s.phase === 'expiring'
        ? `Lisansınızın süresi ${days} gün sonra doluyor (${when}).`
        : `${restricted ? remoteText(s.reason) : 'Lisans süresi doldu'}. Lisans zorunlu olmadığından satış devam ediyor.`;
    return { level: banner.level, text, action: 'Ayrıntılar' };
  }

  switch (s.phase) {
    case 'trial':
      return {
        level: banner.level,
        text: `Deneme sürümü: ${days} gün kaldı. Satışa kesintisiz devam etmek için lisans anahtarınızı girin.`,
        action: 'Lisans anahtarı gir',
      };
    case 'unlicensed':
      return {
        level: banner.level,
        text: 'Lisans tanımlı değil: yeni adisyon açılamıyor. Menü, masa, kullanıcı ve yazıcı ayarlarını yapabilir, lisans anahtarınızı girebilirsiniz.',
        action: 'Lisans anahtarı gir',
      };
    case 'expiring':
      return {
        level: banner.level,
        text: `Lisansınızın süresi ${days} gün sonra doluyor (${when}). Yenilemek için satıcınızla görüşün.`,
        action: 'Ayrıntılar',
      };
    case 'grace':
      return {
        level: banner.level,
        text: `${restricted ? remoteText(s.reason) : 'Lisans süresi doldu'}: ${when} itibarıyla yeni adisyon açılamayacak (${days} gün kaldı). Açık adisyonlar her zaman kapatılabilir.`,
        action: 'Ayrıntılar',
      };
    case 'locked':
      return {
        level: banner.level,
        text: `${restricted ? remoteText(s.reason) : 'Lisans süresi doldu'}: yeni adisyon açılamıyor. Açık adisyonlar ödenip kapatılabilir.`,
        action: 'Ayrıntılar',
      };
    default:
      return null;
  }
}

const LOCK_TITLES: Record<LicenseReason, string> = {
  no_license: 'Lisans gerekli',
  expired: 'Lisans süresi doldu',
  suspended: 'Lisans askıya alındı',
  revoked: 'Lisans iptal edildi',
};

/** Lisans penceresinin basligi ve aciklamasi (kilitliyken ya da seritten acilinca). */
export function lockDialogContent(s: LicenseStatus | undefined): {
  title: string;
  message: string;
} {
  if (!s) return { title: 'Lisans', message: 'Lisans durumu okunuyor…' };
  if (s.locked) {
    const next = isRemoteRestriction(s.reason)
      ? 'Lisansınızla ilgili satıcınızla görüşün.'
      : 'Satıcınızdan aldığınız lisans anahtarını girerek hemen devam edebilirsiniz.';
    return {
      title: LOCK_TITLES[s.reason ?? 'expired'],
      message: `Yeni adisyon açılamıyor. Açık adisyonlar ödenip kapatılabilir; raporlar, yedekleme, ayarlar ve menü her zaman açıktır. ${next}`,
    };
  }
  const banner = bannerContent(s);
  if (banner) return { title: 'Lisans', message: banner.text };
  return {
    title: 'Lisans',
    message: s.phase === 'active' ? 'Lisansınız geçerli.' : 'Lisans zorunlu değil.',
  };
}

export type BadgeTone = 'neutral' | 'info' | 'ok' | 'warning' | 'danger';

/** Ayarlar kartindaki durum etiketi. */
export function statusBadge(s: LicenseStatus): { label: string; tone: BadgeTone } {
  const remote = isRemoteRestriction(s.reason);
  switch (s.phase) {
    case 'trial':
      return { label: 'Deneme', tone: 'info' };
    case 'unlicensed':
      return { label: 'Lisans tanımlı değil', tone: s.enforced ? 'danger' : 'neutral' };
    case 'active':
      return { label: 'Geçerli', tone: 'ok' };
    case 'expiring':
      return { label: 'Süresi yaklaşıyor', tone: 'warning' };
    case 'grace':
      return {
        label: remote
          ? `${s.reason === 'suspended' ? 'Askıya alındı' : 'İptal edildi'} (ek süre)`
          : 'Süresi doldu (ek süre)',
        tone: 'warning',
      };
    case 'locked':
      return {
        label: remote
          ? s.reason === 'suspended'
            ? 'Askıya alındı'
            : 'İptal edildi'
          : 'Süresi doldu',
        tone: s.enforced ? 'danger' : 'warning',
      };
    default:
      return { label: 'Bilinmiyor', tone: 'neutral' };
  }
}

/** Kartin alt notu: zorunlulukta ne durur, ne hep acik kalir. */
export function policySummary(s: LicenseStatus): string {
  if (!s.enforced) {
    return 'Lisans zorunluluğu kapalı — süre dolsa bile sistem çalışmaya devam eder.';
  }
  return `Lisans zorunlu: bitişten 14 gün önce uyarı verilir; süre dolunca ${s.graceDays} gün ek süre tanınır, ardından yeni adisyon açılamaz. Açık adisyonlar kapatılabilir; raporlar, yedekleme, ayarlar, menü ve lisans girişi her zaman açıktır.`;
}

/** Evreye ozel kisa satirlar (deneme sonu, kilit tarihi, bulut durumu). */
export function phaseDetails(s: LicenseStatus): string[] {
  const lines: string[] = [];
  if (s.phase === 'trial' && s.trialEndsAt) {
    lines.push(`Deneme süresi ${formatMoment(s.trialEndsAt)} itibarıyla biter.`);
  }
  if (s.enforced && s.phase === 'unlicensed') {
    lines.push('Lisans girilene kadar yeni adisyon açılamaz.');
  }
  if (s.enforced && s.phase === 'grace' && s.lockAt) {
    lines.push(`Yeni adisyon ${formatMoment(s.lockAt)} itibarıyla durur.`);
  }
  if (s.enforced && s.phase === 'locked') lines.push('Yeni adisyon açılamıyor.');
  if (s.remoteState === 'suspended') lines.push('Bulut: lisans askıya alındı.');
  if (s.remoteState === 'revoked') lines.push('Bulut: lisans iptal edildi.');
  return lines;
}

import { useQuery } from '@tanstack/react-query';
import { api, openLicenseDialog } from '../lib/api';
import { bannerContent, type BannerLevel, type LicenseStatus } from './license-notice';

// Kalici lisans seridi (tum ekranlarin ustunde): deneme, bitise az kalmasi, ek sure ve kilit,
// bulutun askiya almasi/iptali. Lisanssiz yeni kurulumda lisans girme cagrisi da budur.
// Zorunluluk kapali ve soylenecek bir sey yoksa hic gorunmez. Dugme lisans penceresini acar.

/** GET /license; Ayarlar karti ve kilit penceresi ayni onbellegi (['license']) paylasir. */
export function useLicenseStatus() {
  return useQuery({
    queryKey: ['license'],
    queryFn: () => api<LicenseStatus>('/license'),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

const LEVEL_CLASS: Record<BannerLevel, string> = {
  info: 'border-sky-200 bg-sky-50 text-sky-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  danger: 'border-red-200 bg-red-50 text-red-900',
};

export default function LicenseBanner() {
  const status = useLicenseStatus();
  const content = status.data ? bannerContent(status.data) : null;
  if (!content) return null;
  return (
    <div
      role={content.level === 'danger' ? 'alert' : 'status'}
      data-testid="license-banner"
      className={`flex shrink-0 items-center gap-3 border-b px-4 py-2 text-sm print:hidden ${LEVEL_CLASS[content.level]}`}
    >
      <p className="min-w-0 flex-1 font-medium">{content.text}</p>
      <button
        type="button"
        onClick={openLicenseDialog}
        className="min-h-9 shrink-0 rounded-xl bg-white/90 px-3 text-xs font-bold shadow-sm ring-1 ring-black/10 hover:bg-white"
      >
        {content.action}
      </button>
    </div>
  );
}

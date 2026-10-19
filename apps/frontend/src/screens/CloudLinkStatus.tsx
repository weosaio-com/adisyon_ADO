import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasPerm } from '../lib/api';
import type { CloudLinkMode, CloudStatus } from '../lib/types';
import { useDialogs } from '../components/DialogProvider';

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

const TONE: Record<'ok' | 'wait' | 'warn' | 'bad', { dot: string; text: string }> = {
  ok: { dot: 'bg-green-500', text: 'text-slate-600' },
  wait: { dot: 'bg-slate-400', text: 'text-slate-600' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-800' },
  bad: { dot: 'bg-red-500', text: 'text-red-700' },
};

const BUTTON =
  'ml-2 rounded bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40';

// Lisans kartindaki bulut baglantisi satiri. Lisansli kurulum buluta kendiliginden baglanir; satir
// durumu soyler (bagli, baglaniyor, internet yok, baska bilgisayarda, iptal) ve gerekirse sahibin
// onayini ister ("Bu bilgisayara al"). Bulut tanimli degilse ya da lisans yoksa gorunmez.
export default function CloudLinkStatus({ onError }: { onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const { confirmDialog } = useDialogs();
  const allowed = hasPerm('settings.manage');
  const status = useQuery({
    queryKey: ['cloud', 'status'],
    queryFn: () => api<CloudStatus>('/cloud/status'),
    enabled: allowed,
    // Baglanirken sonucu hemen gostermek icin sik yokla.
    refetchInterval: (query) => {
      const link = query.state.data?.link;
      return link === 'linking' || link === 'waiting_network' ? 2000 : 30_000;
    },
  });
  const link = useMutation({
    mutationFn: (takeover: boolean) =>
      api<CloudStatus>('/cloud/activate', { method: 'POST', body: takeover ? { takeover } : {} }),
    onSuccess: (next) => qc.setQueryData(['cloud', 'status'], next),
    onError,
  });

  const s = status.data;
  if (!allowed || !s || s.link === 'unconfigured' || s.link === 'no_license') return null;

  const button = (label: string, takeover: boolean, testId: string) => (
    <button
      onClick={async () => {
        if (
          takeover &&
          !(await confirmDialog({
            title: 'Bu bilgisayara al',
            message:
              'Bu lisans başka bir bilgisayarda buluta bağlı. Bu bilgisayara alırsanız diğer bilgisayarın bulut bağlantısı kesilir (QR menüyü artık o güncelleyemez). Devam edilsin mi?',
            confirmLabel: 'Bu bilgisayara al',
          }))
        ) {
          return;
        }
        link.mutate(takeover);
      }}
      disabled={link.isPending}
      className={BUTTON}
      data-testid={testId}
    >
      {link.isPending ? 'Bağlanıyor…' : label}
    </button>
  );

  const view: Record<
    CloudLinkMode,
    { tone: keyof typeof TONE; text: string; action?: React.ReactNode }
  > = {
    unconfigured: { tone: 'wait', text: '' },
    no_license: { tone: 'wait', text: '' },
    legacy_license: {
      tone: 'warn',
      text: 'bu lisans buluta bağlanamaz (lisans numarası yok); satıcınızdan yeni lisans isteyin',
    },
    linking: { tone: 'wait', text: 'bağlanıyor…' },
    waiting_network: { tone: 'warn', text: 'internet yok, bekliyor' },
    conflict: {
      tone: 'warn',
      text: `bu lisans başka bilgisayarda açık${
        s.conflictLastSeenAt ? ` (son görülme ${when(s.conflictLastSeenAt)})` : ''
      }`,
      action: button('Bu bilgisayara al', true, 'cloud-takeover'),
    },
    lost: {
      tone: 'warn',
      text: 'bu bilgisayarın bağlantısı satıcı tarafından kaldırıldı',
      action: button('Yeniden bağlan', false, 'cloud-relink'),
    },
    error: {
      tone: 'warn',
      text: `bağlanamadı${s.linkError ? ` (${s.linkError})` : ''}; kendiliğinden yeniden denenecek`,
      action: button('Yeniden dene', false, 'cloud-retry'),
    },
    linked: { tone: 'ok', text: `bağlı · son görülme ${when(s.lastSeenAt)}` },
    suspended: { tone: 'bad', text: 'hizmet satıcı tarafından askıya alındı' },
    expired: { tone: 'warn', text: 'bağlı · bulutta lisans süresi dolmuş görünüyor' },
    revoked: { tone: 'bad', text: 'lisans iptal edildi; satıcınıza başvurun' },
  };
  const line = view[s.link];
  const tone = TONE[line.tone];

  return (
    <p
      className={`flex flex-wrap items-center gap-x-1 text-sm ${tone.text}`}
      data-testid="cloud-link"
      data-mode={s.link}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />
      <span>Bulut: {line.text}</span>
      {line.action}
    </p>
  );
}

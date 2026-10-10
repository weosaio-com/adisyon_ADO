import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { CloudLostReason, CloudStatus } from '../lib/types';

const PRIMARY =
  'w-full rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40 hover:bg-blue-700';
const NOTE = 'rounded-lg p-2 text-sm';

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

const LOST: Record<CloudLostReason, string> = {
  superseded: 'Bu lisansla QR menü başka bir bilgisayarda açıldı.',
  rotated: 'Bu bilgisayarın QR menü bağlantısı yenilendi.',
  revoked: 'QR menü bağlantısı satıcı tarafından kaldırıldı.',
  unpaired: 'QR menü başka bir yerden kapatıldı.',
  invalid: 'QR menü bağlantısı artık geçerli değil.',
};

// QR menu: lisansla tek tikla acilir (adres ve kod girilmez); menu degistikce kendiliginden
// yayinlanir. Kart her durumda ne yapilacagini soyler (backend cloud.state.ts CloudMode).
export default function CloudMenuCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (message: string) => void;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const status = useQuery({
    queryKey: ['cloud', 'status'],
    queryFn: () => api<CloudStatus>('/cloud/status'),
    // Yayin surerken ya da internet beklenirken sonucu hemen gostermek icin sik yokla.
    refetchInterval: (query) =>
      query.state.data?.publishing || query.state.data?.mode === 'waiting_network' ? 2000 : 30_000,
  });
  const apply = (next: CloudStatus) => qc.setQueryData(['cloud', 'status'], next);

  const activate = useMutation({
    mutationFn: (takeover: boolean) =>
      api<CloudStatus>('/cloud/activate', { method: 'POST', body: takeover ? { takeover } : {} }),
    onSuccess: (next) => {
      apply(next);
      if (next.mode === 'on') onInfo('QR menü açıldı; menü yayınlanıyor.');
      if (next.mode === 'waiting_network')
        onInfo('İnternet yok. İnternet gelince QR menü kendiliğinden açılacak.');
    },
    onError,
  });
  const publish = useMutation({
    mutationFn: () => api<CloudStatus>('/cloud/publish', { method: 'POST' }),
    onSuccess: apply,
    onError,
  });
  // `close`: acik QR menuyu kapatma; degilse bekleyen acmadan/devralmadan vazgecme.
  const disconnect = useMutation({
    mutationFn: (_close: boolean) => api<CloudStatus>('/cloud/connection', { method: 'DELETE' }),
    onSuccess: (next, close) => {
      apply(next);
      if (close) onInfo('QR menü kapatıldı. Masalardaki QR kodlar menü açmaz.');
    },
    onError,
  });

  const s = status.data;
  // Bu kurulumda bulut tanimli degilse (derleme profili) kart gorunmez.
  if (!s?.enabled) return null;
  const busy = activate.isPending || disconnect.isPending;

  const openButton = (label: string, takeover = false) => (
    <button
      onClick={() => activate.mutate(takeover)}
      disabled={busy}
      className={PRIMARY}
      data-testid={takeover ? 'cloud-takeover' : 'cloud-activate'}
    >
      {activate.isPending ? 'Açılıyor…' : label}
    </button>
  );
  const dismissButton = (
    <button
      onClick={() => disconnect.mutate(false)}
      disabled={busy}
      className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-40"
    >
      Vazgeç
    </button>
  );

  let body: React.ReactNode;
  switch (s.mode) {
    case 'no_license':
      body = (
        <p className={`${NOTE} bg-slate-50 text-slate-700`} data-testid="cloud-no-license">
          QR menü için önce aşağıdaki <b>Lisans</b> bölümünden lisansınızı girin.
        </p>
      );
      break;
    case 'not_licensed':
      body = (
        <p className={`${NOTE} bg-amber-50 text-amber-900`}>
          Lisansınız QR menüyü içermiyor. Satıcınızla görüşün.
        </p>
      );
      break;
    case 'expired':
      body = (
        <p className={`${NOTE} bg-red-50 text-red-700`}>
          Lisansınızın süresi doldu; QR menü yayınlanmıyor. Yeni lisansı aşağıdaki <b>Lisans</b>{' '}
          bölümüne girin.
        </p>
      );
      break;
    case 'off':
      body = (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Müşteriler masadaki QR kodu okutup menüyü telefonda görür. Menü bu programdan yönetilir;
            ürün ve fiyat değiştikçe kendiliğinden güncellenir.
          </p>
          {openButton('QR menüyü aç')}
        </div>
      );
      break;
    case 'waiting_network':
      body = (
        <div className="space-y-2">
          <p className={`${NOTE} bg-amber-50 text-amber-900`} data-testid="cloud-waiting">
            İnternet bekleniyor. Bağlantı gelince QR menü kendiliğinden açılacak.
          </p>
          {dismissButton}
        </div>
      );
      break;
    case 'conflict':
      body = (
        <div className="space-y-2">
          <p className={`${NOTE} bg-amber-50 text-amber-900`} data-testid="cloud-conflict">
            Bu lisansla QR menü başka bir bilgisayarda açık
            {s.conflictLastSeenAt ? ` (son görülme ${when(s.conflictLastSeenAt)})` : ''}. Bu
            bilgisayara taşırsanız diğer bilgisayar menüyü artık güncelleyemez.
          </p>
          {openButton('Bu bilgisayara taşı', true)}
          {dismissButton}
        </div>
      );
      break;
    case 'lost':
      body = (
        <div className="space-y-2">
          <p className={`${NOTE} bg-amber-50 text-amber-900`} data-testid="cloud-lost">
            {LOST[s.lostReason ?? 'invalid']}
          </p>
          {s.lostReason === 'superseded'
            ? openButton('Bu bilgisayarda aç', true)
            : openButton('QR menüyü yeniden aç')}
          {dismissButton}
        </div>
      );
      break;
    default:
      body = (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-500">İşletme</dt>
            <dd className="font-medium text-slate-800">
              {s.tenantName}
              {s.branchName && s.branchName !== s.tenantName ? ` · ${s.branchName}` : ''}
            </dd>
            <dt className="text-slate-500">Adres</dt>
            <dd className="truncate text-slate-800">{s.url}</dd>
            <dt className="text-slate-500">Son yayın</dt>
            <dd className="text-slate-800" data-testid="cloud-last-published">
              {s.publishing
                ? 'Yayınlanıyor…'
                : s.lastPublishedAt
                  ? `${when(s.lastPublishedAt)} (sürüm ${s.lastMenuVersion})`
                  : 'Henüz yok'}
            </dd>
          </dl>
          {s.mode === 'suspended' && (
            <p className={`${NOTE} bg-red-50 text-red-700`} data-testid="cloud-suspended">
              QR menünüz askıya alındı; müşteri sayfası açılmaz. Satıcınızla görüşün.
            </p>
          )}
          {s.lastError && !s.publishing && s.mode === 'on' && (
            <p className={`${NOTE} bg-red-50 text-red-700`} data-testid="cloud-error">
              Son yayın başarısız ({when(s.lastErrorAt)}): {s.lastError}. Kendiliğinden yeniden
              denenecek.
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => publish.mutate()}
              disabled={publish.isPending || s.publishing || s.mode !== 'on'}
              className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              Şimdi yayınla
            </button>
            <button
              onClick={() => nav('/qr-codes')}
              className="flex-1 rounded-lg bg-slate-200 py-2 text-sm font-semibold text-slate-800"
            >
              Masa QR kodları
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Ürün, kategori, masa ve işletme bilgisi değişiklikleri birkaç saniye içinde
            kendiliğinden yayınlanır. İnternet kesikse bağlantı gelince yayınlanır.
          </p>
          <button
            onClick={() => {
              if (
                window.confirm(
                  'QR menü kapatılsın mı? Masalardaki QR kodlar menü açmaz (yeniden açınca aynı kodlar çalışır).',
                )
              ) {
                disconnect.mutate(true);
              }
            }}
            disabled={busy}
            className="text-sm text-red-600 hover:text-red-800 disabled:opacity-40"
            data-testid="cloud-disconnect"
          >
            QR menüyü kapat
          </button>
        </div>
      );
  }

  return (
    <div className="rounded-2xl bg-white p-4 shadow" data-testid="cloud-card">
      <h2 className="mb-1 font-bold text-slate-800">QR Menü</h2>
      {body}
    </div>
  );
}

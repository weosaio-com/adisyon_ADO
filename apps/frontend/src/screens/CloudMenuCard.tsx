import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { CloudLinkMode, CloudStatus } from '../lib/types';
import { useDialogs } from '../components/DialogProvider';

const PRIMARY =
  'w-full rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40 hover:bg-blue-700';
const NOTE = 'rounded-lg p-2 text-sm';

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

// QR menu acikken bulut baglantisi henuz yoksa ne bekleniyor (baglanti Lisans kartinda yonetilir).
const WAITING: Partial<Record<CloudLinkMode, string>> = {
  linking: 'Bulut bağlantısı kuruluyor; bağlanınca menü kendiliğinden yayınlanır.',
  waiting_network: 'İnternet bekleniyor; bağlantı gelince menü kendiliğinden yayınlanır.',
  conflict:
    'Bu lisans başka bir bilgisayarda buluta bağlı. Aşağıdaki Lisans bölümünden “Bu bilgisayara al” deyin.',
  lost: 'Bu bilgisayarın bulut bağlantısı satıcı tarafından kaldırıldı. Lisans bölümünden yeniden bağlanın.',
  error: 'Buluta bağlanılamadı; kendiliğinden yeniden denenecek.',
  revoked: 'Lisansınız iptal edildi; QR menü yayınlanmıyor. Satıcınıza başvurun.',
  suspended: 'QR menünüz askıya alındı; müşteri sayfası açılmaz. Satıcınızla görüşün.',
};

// Bulutun yayini reddetme nedeni (bagliyken).
const BLOCKED: Record<string, string> = {
  suspended: 'QR menünüz askıya alındı; müşteri sayfası açılmaz. Satıcınızla görüşün.',
  expired: 'Lisansınızın süresi doldu; QR menü yayınlanmıyor. Yeni lisansı Lisans bölümüne girin.',
  revoked: 'Lisansınız iptal edildi; QR menü yayınlanmıyor. Satıcınıza başvurun.',
};

// QR menu: tek tikla acilir/kapanir (adres ve kod girilmez); acikken menu degistikce kendiliginden
// yayinlanir. Bulut baglantisi lisansla kendiliginden kurulur ve Lisans kartinda gorunur; bu kart
// yalniz QR menu yayinini yonetir (backend cloud.state.ts CloudQrMode).
export default function CloudMenuCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (message: string) => void;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { confirmDialog } = useDialogs();
  const status = useQuery({
    queryKey: ['cloud', 'status'],
    queryFn: () => api<CloudStatus>('/cloud/status'),
    // Yayin, baglanma ya da bulutta kapatma surerken sonucu hemen gostermek icin sik yokla.
    refetchInterval: (query) => {
      const s = query.state.data;
      const busy =
        s?.publishing ||
        s?.unpublishPending ||
        (s?.qr === 'on' && (s.link === 'linking' || s.link === 'waiting_network'));
      return busy ? 2000 : 30_000;
    },
  });
  const apply = (next: CloudStatus) => qc.setQueryData(['cloud', 'status'], next);

  const setQr = useMutation({
    mutationFn: (enabled: boolean) =>
      api<CloudStatus>('/cloud/qr', { method: 'PUT', body: { enabled } }),
    onSuccess: (next, enabled) => {
      apply(next);
      if (!enabled) {
        onInfo(
          'QR menü kapatıldı. Masalardaki QR kodlar menü açmaz (yeniden açınca aynı kodlar çalışır).',
        );
      } else if (next.connected) {
        onInfo('QR menü açıldı; menü yayınlanıyor.');
      } else if (next.link === 'waiting_network') {
        onInfo('İnternet yok. Bağlantı gelince QR menü kendiliğinden yayınlanacak.');
      }
    },
    onError,
  });
  const publish = useMutation({
    mutationFn: () => api<CloudStatus>('/cloud/publish', { method: 'POST' }),
    onSuccess: apply,
    onError,
  });

  const s = status.data;
  // Bu kurulumda bulut tanimli degilse (derleme profili) kart gorunmez.
  if (!s?.enabled) return null;

  const closeButton = (
    <button
      onClick={async () => {
        const ok = await confirmDialog({
          title: 'QR menü kapatılsın mı?',
          message: 'Masalardaki QR kodlar menü açmaz (yeniden açınca aynı kodlar çalışır).',
          confirmLabel: 'QR menüyü kapat',
          danger: true,
        });
        if (ok) setQr.mutate(false);
      }}
      disabled={setQr.isPending}
      className="text-sm text-red-600 hover:text-red-800 disabled:opacity-40"
      data-testid="qr-disable"
    >
      QR menüyü kapat
    </button>
  );

  let body: React.ReactNode;
  if (s.qr === 'not_licensed') {
    body =
      s.link === 'no_license' ? (
        <p className={`${NOTE} bg-slate-50 text-slate-700`} data-testid="cloud-no-license">
          QR menü için önce aşağıdaki <b>Lisans</b> bölümünden lisansınızı girin.
        </p>
      ) : s.link === 'legacy_license' ? (
        <p className={`${NOTE} bg-amber-50 text-amber-900`}>
          Lisansınızda lisans numarası yok; QR menü için satıcınızdan yeni lisans isteyin.
        </p>
      ) : (
        <p className={`${NOTE} bg-amber-50 text-amber-900`} data-testid="qr-not-licensed">
          Lisansınız QR menüyü içermiyor. Satıcınızla görüşün.
        </p>
      );
  } else if (s.qr === 'off') {
    body = (
      <div className="space-y-2">
        <p className="text-xs text-slate-500">
          Müşteriler masadaki QR kodu okutup menüyü telefonda görür. Menü bu programdan yönetilir;
          ürün ve fiyat değiştikçe kendiliğinden güncellenir.
        </p>
        {s.unpublishPending && (
          <p className={`${NOTE} bg-amber-50 text-amber-900`} data-testid="qr-unpublish-pending">
            QR menü kapatıldı; buluttan kaldırma internet gelince tamamlanacak.
          </p>
        )}
        <button
          onClick={() => setQr.mutate(true)}
          disabled={setQr.isPending}
          className={PRIMARY}
          data-testid="qr-enable"
        >
          {setQr.isPending ? 'Açılıyor…' : 'QR menüyü aç'}
        </button>
      </div>
    );
  } else if (!s.connected) {
    body = (
      <div className="space-y-2">
        <p className={`${NOTE} bg-amber-50 text-amber-900`} data-testid="qr-waiting">
          {WAITING[s.link] ?? WAITING.linking}
          {s.link === 'error' && s.linkError ? ` (${s.linkError})` : ''}
        </p>
        {closeButton}
      </div>
    );
  } else {
    const blocked = s.blocked ? BLOCKED[s.blocked] : undefined;
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
        {blocked && (
          <p className={`${NOTE} bg-red-50 text-red-700`} data-testid="cloud-suspended">
            {blocked}
          </p>
        )}
        {s.lastError && !s.publishing && !blocked && (
          <p className={`${NOTE} bg-red-50 text-red-700`} data-testid="cloud-error">
            Son yayın başarısız ({when(s.lastErrorAt)}): {s.lastError}. Kendiliğinden yeniden
            denenecek.
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => publish.mutate()}
            disabled={publish.isPending || s.publishing || Boolean(blocked)}
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
          Ürün, kategori, masa ve işletme bilgisi değişiklikleri birkaç saniye içinde kendiliğinden
          yayınlanır. İnternet kesikse bağlantı gelince yayınlanır.
        </p>
        {closeButton}
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

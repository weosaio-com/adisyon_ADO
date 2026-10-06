import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { CloudStatus } from '../lib/types';

const INPUT = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

// QR menu: panelden alinan kodla buluta baglan; menu degistikce kendiliginden yayinlanir.
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
    // Yayin surerken sonucu hemen gostermek icin sik yokla.
    refetchInterval: (query) => (query.state.data?.publishing ? 2000 : 30_000),
  });
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const apply = (next: CloudStatus) => qc.setQueryData(['cloud', 'status'], next);

  const pair = useMutation({
    mutationFn: () =>
      api<CloudStatus>('/cloud/pair', {
        method: 'POST',
        body: { url: url.trim(), code: code.trim() },
      }),
    onSuccess: (next) => {
      apply(next);
      setCode('');
      onInfo('QR menü bulutuna bağlandı; menü yayınlanıyor.');
    },
    onError,
  });
  const publish = useMutation({
    mutationFn: () => api<CloudStatus>('/cloud/publish', { method: 'POST' }),
    onSuccess: apply,
    onError,
  });
  const disconnect = useMutation({
    mutationFn: () => api<CloudStatus>('/cloud/connection', { method: 'DELETE' }),
    onSuccess: (next) => {
      apply(next);
      onInfo('Bulut bağlantısı kaldırıldı. Masalardaki QR kodlar menüyü güncellemez.');
    },
    onError,
  });

  const s = status.data;
  // Lisans QR menuyu kapattiysa kart hic gorunmez.
  if (!s?.enabled) return null;

  return (
    <div className="rounded-2xl bg-white p-4 shadow" data-testid="cloud-card">
      <h2 className="mb-1 font-bold text-slate-800">QR Menü (Bulut)</h2>
      {!s.connected ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Müşteriler masadaki QR kodu okutup menüyü telefonda görür. Bulut adresini ve panelden
            aldığınız eşleştirme kodunu girin.
          </p>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Bulut adresi (ör. menu.ornek.com)"
            inputMode="url"
            className={INPUT}
          />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Eşleştirme kodu (ABCD-EFGH)"
            maxLength={12}
            autoCapitalize="characters"
            className={`${INPUT} font-mono tracking-widest`}
          />
          <button
            onClick={() => pair.mutate()}
            disabled={!url.trim() || code.trim().length < 8 || pair.isPending}
            className="w-full rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
          >
            {pair.isPending ? 'Bağlanıyor…' : 'Bağlan'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-500">İşletme</dt>
            <dd className="font-medium text-slate-800">
              {s.tenantName}
              {s.branchName && s.branchName !== s.tenantName ? ` · ${s.branchName}` : ''}
            </dd>
            <dt className="text-slate-500">Paket</dt>
            <dd className="text-slate-800">{s.planLabel}</dd>
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
          {s.menuEnabled === false && (
            <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
              Paketiniz QR menüyü içermiyor; müşteri sayfası açılmaz.
            </p>
          )}
          {s.lastError && !s.publishing && (
            <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700" data-testid="cloud-error">
              Son yayın başarısız ({when(s.lastErrorAt)}): {s.lastError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => publish.mutate()}
              disabled={publish.isPending || s.publishing}
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
          {s.url && (
            // Panel bulutta: masaustu programda sistem tarayicisinda acilir (apps/desktop/main.mjs).
            <a
              href={`${s.url}/panel`}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg bg-slate-100 py-2 text-center text-sm font-semibold text-slate-800 hover:bg-slate-200"
              data-testid="cloud-panel-link"
            >
              İşletme panelini aç ↗
            </a>
          )}
          <p className="text-xs text-slate-500">
            Ürün, kategori ve masa değişiklikleri birkaç saniye içinde kendiliğinden yayınlanır.
            İşletme panelini telefon ya da bilgisayara uygulama olarak da yükleyebilirsiniz.
          </p>
          <button
            onClick={() => {
              if (window.confirm('Bulut bağlantısı kaldırılsın mı? Menü artık güncellenmez.')) {
                disconnect.mutate();
              }
            }}
            disabled={disconnect.isPending}
            className="text-sm text-red-600 hover:text-red-800 disabled:opacity-40"
          >
            Bağlantıyı kaldır
          </button>
        </div>
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { UpdateStatusView } from '../lib/types';

const NOTE = 'rounded-lg p-2 text-sm';

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
}

// Otomatik guncelleme: program yeni surumu kendisi denetler ve indirir; kurulum yalniz yoneticinin
// onayiyla, kasa bilgisayarindan ve acik adisyon/kasa yokken (backend kurallari). Kart yalniz
// masaustu programinda ve guncelleme anahtari tanimliysa gorunur.
export default function UpdateCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (message: string) => void;
}) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['updates', 'status'],
    queryFn: () => api<UpdateStatusView>('/updates/status'),
    refetchInterval: (query) =>
      ['checking', 'downloading', 'installing'].includes(query.state.data?.state ?? '')
        ? 2000
        : 60_000,
  });
  const apply = (next: UpdateStatusView) => qc.setQueryData(['updates', 'status'], next);
  const check = useMutation({
    mutationFn: () => api<UpdateStatusView>('/updates/check', { method: 'POST' }),
    onSuccess: apply,
    onError,
  });
  const install = useMutation({
    mutationFn: (version: string) =>
      api<UpdateStatusView>('/updates/approve', { method: 'POST', body: { version } }),
    onSuccess: (next) => {
      apply(next);
      onInfo('Güncelleme kuruluyor. Program birkaç dakika içinde yeniden açılacak.');
    },
    onError,
  });

  const s = status.data;
  if (!s?.available) return null;

  const checkButton = (label: string) => (
    <button
      onClick={() => check.mutate()}
      disabled={check.isPending}
      className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-800 disabled:opacity-40"
      data-testid="update-check"
    >
      {label}
    </button>
  );

  let body: React.ReactNode;
  switch (s.state) {
    case 'checking':
      body = <p className="text-sm text-slate-600">Güncelleme denetleniyor…</p>;
      break;
    case 'downloading':
      body = (
        <p className="text-sm text-slate-600">
          Yeni sürüm {s.version} indiriliyor… %{s.progress ?? 0}
        </p>
      );
      break;
    case 'ready':
      body = (
        <div className="space-y-2">
          <p className={`${NOTE} bg-blue-50 text-blue-900`}>
            Yeni sürüm <b>{s.version}</b> kurulmaya hazır.
          </p>
          {s.notes && <p className="whitespace-pre-line text-xs text-slate-600">{s.notes}</p>}
          {s.blockers.length > 0 && (
            <ul
              className={`${NOTE} list-disc space-y-1 bg-amber-50 pl-6 text-amber-900`}
              data-testid="update-blockers"
            >
              {s.blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.message}</li>
              ))}
            </ul>
          )}
          <button
            onClick={() => {
              if (
                s.version &&
                window.confirm(
                  'Program kapanıp yeniden açılacak; kurulumdan önce yedek alınır. Devam edilsin mi?',
                )
              ) {
                install.mutate(s.version);
              }
            }}
            disabled={!s.canInstall || install.isPending}
            className="w-full rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
            data-testid="update-install"
          >
            {install.isPending ? 'Yedek alınıyor…' : 'Güncellemeyi kur'}
          </button>
        </div>
      );
      break;
    case 'installing':
      body = (
        <p className={`${NOTE} bg-blue-50 text-blue-900`}>
          Güncelleme kuruluyor. Program birkaç dakika içinde yeniden açılacak.
        </p>
      );
      break;
    case 'error':
      body = (
        <div className="space-y-2">
          <p className={`${NOTE} bg-red-50 text-red-700`}>
            Son denetim başarısız ({when(s.checkedAt)}): {s.error}
          </p>
          {checkButton('Tekrar dene')}
        </div>
      );
      break;
    default:
      body = (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-slate-600">Program güncel. Son denetim: {when(s.checkedAt)}</p>
          {checkButton('Şimdi kontrol et')}
        </div>
      );
  }

  const last = s.lastUpdate;
  return (
    <div className="rounded-2xl bg-white p-4 shadow" data-testid="update-card">
      <h2 className="mb-1 font-bold text-slate-800">Güncelleme</h2>
      <p className="mb-2 text-xs text-slate-500" data-testid="update-state">
        Sürüm {s.currentVersion ?? '—'}
        {s.channel === 'beta' ? ' · beta kanalı' : ''}
      </p>
      {body}
      {last && (
        <p className="mt-2 text-xs text-slate-400">
          Son kurulum: {last.fromVersion} → {last.toVersion}{' '}
          {last.status === 'applied'
            ? `kuruldu (${when(last.appliedAt)})`
            : last.status === 'failed'
              ? `kurulamadı${last.error ? `: ${last.error}` : ''}`
              : 'bekleniyor'}
        </p>
      )}
    </div>
  );
}

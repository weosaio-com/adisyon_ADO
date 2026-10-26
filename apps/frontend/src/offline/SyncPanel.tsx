import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { problemsAll, problemsDelete } from './db';
import { getState, kick, refreshPending, subscribe } from './engine';

// SyncBadge'den ayri: dongusel import olmasin.
function useSyncState() {
  return useSyncExternalStore(subscribe, getState, getState);
}

const MODE_TEXT: Record<string, string> = {
  online: 'Ana bilgisayara bağlı.',
  offline:
    'Ana bilgisayara ulaşılamıyor. Siparişler bu tablette saklanıyor; bağlantı gelince kendiliğinden gönderilecek.',
  syncing: 'Bekleyen işlemler ana bilgisayara gönderiliyor…',
};

/** Senkron sorunlari listesi (kalici; garson "Anladım" deyince silinir). */
export function useSyncProblems(enabled = true) {
  return useQuery({
    queryKey: ['sync-problems'],
    queryFn: problemsAll,
    enabled,
    refetchInterval: 5_000,
  });
}

// Gonderim durumu + sunucunun kabul etmedigi / yonetici onayina aldigi kayitlar. OFF-1, OFF-3
export default function SyncPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const sync = useSyncState();
  const problems = useSyncProblems();
  const list = problems.data ?? [];

  const dismiss = async (ids: string[]) => {
    await problemsDelete(ids);
    await refreshPending();
    await qc.invalidateQueries({ queryKey: ['sync-problems'] });
  };

  // Portal: rozet bulaniklastirilmis (backdrop-blur) basligin icinde; sabit konumlu pencere
  // orada basliga hapsolur. Pencere govdeye cizilir.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bağlantı ve gönderim"
        data-testid="sync-panel"
        className="flex max-h-full w-full max-w-md flex-col rounded-3xl bg-white p-5 text-left shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-black text-ink-900">Bağlantı ve gönderim</h2>
          <button
            onClick={onClose}
            className="min-h-11 rounded-xl border border-stone-200 px-4 text-sm font-bold text-stone-600"
          >
            Kapat
          </button>
        </div>
        <p className="text-sm text-stone-600">
          {sync.mode === 'waiting' ? sync.note : (MODE_TEXT[sync.mode] ?? '')}
        </p>
        {sync.pending > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span data-testid="sync-pending">
              Gönderilmeyi bekleyen <b>{sync.pending}</b> işlem var.
            </span>
            {sync.mode !== 'offline' && sync.mode !== 'syncing' && (
              <button
                onClick={() => void kick()}
                className="min-h-11 shrink-0 rounded-xl bg-amber-900 px-3 font-bold text-white"
              >
                Şimdi gönder
              </button>
            )}
          </div>
        )}
        <SyncProblemList
          problems={list}
          onDismiss={(ids) => void dismiss(ids)}
          className="mt-4 min-h-0 flex-1 overflow-auto"
        />
      </div>
    </div>,
    document.body,
  );
}

function SyncProblemList({
  problems,
  onDismiss,
  className = '',
}: {
  problems: Awaited<ReturnType<typeof problemsAll>>;
  onDismiss: (ids: string[]) => void;
  className?: string;
}) {
  if (problems.length === 0) {
    return <p className={`${className} text-sm text-stone-500`}>Senkron sorunu yok.</p>;
  }
  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-black text-ink-900">Senkron sorunları ({problems.length})</h3>
        {problems.length > 1 && (
          <button
            onClick={() => onDismiss(problems.map((p) => p.id))}
            className="min-h-11 rounded-xl px-3 text-sm font-bold text-stone-600 hover:bg-stone-100"
          >
            Tümünü kapat
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {problems.map((p) => (
          <li
            key={p.id}
            data-testid="sync-problem"
            className={`rounded-2xl border p-3 text-sm ${
              p.kind === 'conflict'
                ? 'border-amber-200 bg-amber-50 text-amber-950'
                : 'border-red-200 bg-red-50 text-red-950'
            }`}
          >
            <p className="text-xs font-bold tracking-wide uppercase opacity-70">
              {p.orderLabel} ·{' '}
              {new Date(p.createdAt).toLocaleTimeString('tr-TR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
            <p className="mt-1 font-semibold">{p.message}</p>
            <button
              onClick={() => onDismiss([p.id])}
              className="mt-2 min-h-11 rounded-xl bg-white/80 px-4 text-sm font-bold"
            >
              Anladım
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Masa planinda: senkron sorunu varsa garsonu uyaran serit (ayrinti paneli acar). */
export function SyncProblemsBanner() {
  const sync = useSyncState();
  const [open, setOpen] = useState(false);
  if (sync.problems === 0) return null;
  return (
    <>
      <div
        role="alert"
        data-testid="sync-problems-banner"
        className="mb-5 flex flex-col justify-between gap-3 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-3 text-orange-950 sm:flex-row sm:items-center"
      >
        <div>
          <p className="font-black">{sync.problems} işlem sunucuya geçmedi</p>
          <p className="text-sm text-orange-900">
            Reddedilen ya da yönetici onayı bekleyen siparişler var. Müşteriye bilgi verin.
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="min-h-11 shrink-0 rounded-xl bg-orange-900 px-4 text-sm font-bold text-white"
        >
          Ayrıntılar
        </button>
      </div>
      {open && <SyncPanel onClose={() => setOpen(false)} />}
    </>
  );
}

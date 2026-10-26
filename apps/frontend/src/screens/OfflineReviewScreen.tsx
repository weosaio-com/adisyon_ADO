import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLiveEvents } from '../lib/useLiveEvents';
import { formatKurus, formatQty } from '../lib/format';
import type { Table } from '../lib/types';
import { useDialogs } from '../components/DialogProvider';
import { readTables } from '../offline/read';
import { groupReviews, type ReviewGroup, type ReviewRow } from './offline-review';

// Cakisan cevrimdisi siparislerin Owner onay ekrani. OFFLINE_DESIGN.md §8, §9.2
// OFF-2: her kart TEK siparis (masa ac + kalemler + mutfaga gonder); karar tek dokunusla
// tum siparise uygulanir, varsayilan masa korunur, yalniz o siparise uyan dugmeler gorunur.
const REASON: Record<string, string> = {
  cash_closed: 'Kasa kapalıyken gönderildi',
  table_closed: 'Adisyon bu arada kapatılmış',
  table_moved: 'Masa silinmiş ya da taşınmış',
  product_inactive: 'Ürün satışa kapalı',
  price_changed: 'Fiyat değişmiş',
  other: 'Diğer',
};

type Resolution = 'uygula' | 'yeni_adisyon' | 'yeniden_ac' | 'reddet';
const NO_TABLE = '';
const PICK = '__pick__';

interface ResolveResult {
  orderId: string | null;
  failed: { clientOpId: string; reason?: string }[];
}

export default function OfflineReviewScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  useLiveEvents();

  const reviews = useQuery({
    queryKey: ['offline-reviews'],
    queryFn: () => api<ReviewRow[]>('/offline-reviews'),
    refetchInterval: 15_000,
  });
  const tables = useQuery({ queryKey: ['tables', 'active'], queryFn: readTables });

  const resolve = useMutation({
    mutationFn: (v: {
      group: ReviewGroup;
      resolution: Resolution;
      targetTableId?: string | null | undefined;
    }) =>
      api<ResolveResult>('/offline-reviews/resolve-group', {
        method: 'POST',
        body: {
          reviewIds: v.group.ids,
          resolution: v.resolution,
          ...(v.targetTableId !== undefined ? { targetTableId: v.targetTableId } : {}),
        },
      }),
    onSuccess: (result, v) => {
      setError('');
      const failed = result.failed ?? [];
      setInfo(
        v.resolution === 'reddet'
          ? 'Sipariş reddedildi; garsonun tabletine bildirildi.'
          : failed.length > 0
            ? `${failed.length} kalem uygulanamadı (${[...new Set(failed.map((f) => f.reason))].join(', ')}); kartta kaldı.`
            : 'Sipariş uygulandı.',
      );
      qc.invalidateQueries({ queryKey: ['offline-reviews'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => {
      setInfo('');
      setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');
    },
  });

  const groups = groupReviews(reviews.data ?? []);

  return (
    <div className="min-h-full bg-[#f5f5f2]">
      <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-3 sm:px-6">
        <button
          onClick={() => nav('/')}
          className="min-h-11 rounded-xl border border-stone-200 px-4 font-bold text-ink-800"
        >
          ← Masalar
        </button>
        <h1 className="text-xl font-black text-ink-900">Çevrimdışı sipariş onayları</h1>
        {groups.length > 0 && (
          <span className="rounded-full bg-orange-100 px-3 py-1 text-sm font-bold text-orange-700">
            {groups.length} sipariş bekliyor
          </span>
        )}
      </header>

      <main className="mx-auto max-w-5xl p-4 sm:p-6">
        <p className="mb-4 text-sm text-stone-600">
          Bağlantısı kopan tabletlerden gelen ve kendiliğinden uygulanamayan siparişler. Her kart
          tek bir siparişi gösterir; kararınız siparişin tamamına uygulanır.
        </p>
        {error && (
          <p role="alert" className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {info && (
          <p className="mb-3 rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-900">{info}</p>
        )}
        {reviews.isLoading && <p className="text-stone-500">Yükleniyor…</p>}
        {!reviews.isLoading && groups.length === 0 && (
          <p className="rounded-2xl bg-white p-6 text-center text-stone-500">
            Onay bekleyen sipariş yok.
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((group) => (
            <ReviewCard
              key={group.key}
              group={group}
              tables={tables.data ?? []}
              busy={resolve.isPending}
              onResolve={(resolution, targetTableId) =>
                resolve.mutate({ group, resolution, targetTableId })
              }
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function ReviewCard({
  group,
  tables,
  busy,
  onResolve,
}: {
  group: ReviewGroup;
  tables: Table[];
  busy: boolean;
  onResolve: (resolution: Resolution, targetTableId?: string | null) => void;
}) {
  const { confirmDialog } = useDialogs();
  const original = tables.find((t) => t.id === group.tableId);
  const [target, setTarget] = useState(original ? original.id : group.tableId ? PICK : NO_TABLE);
  const needsTable = group.kind !== 'open';
  const targetValue = target === NO_TABLE ? null : target;
  const pickMissing = needsTable && target === PICK;
  const time = new Date(group.createdAt).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const reject = async () => {
    const ok = await confirmDialog({
      title: 'Sipariş reddedilsin mi?',
      message: `${group.lines.length} kalem adisyona eklenmez; garsonun tabletine "reddedildi" bildirimi gider. Bu işlem geri alınamaz.`,
      confirmLabel: 'Siparişi reddet',
      danger: true,
    });
    if (ok) onResolve('reddet');
  };

  return (
    <article data-testid="review-group" className="rounded-3xl bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black text-ink-900">
            {group.tableName
              ? `Masa ${group.tableName}`
              : group.orderNo
                ? `Adisyon #${group.orderNo.split('-')[1] ?? group.orderNo}`
                : 'Masasız sipariş'}
          </h2>
          <p className="text-xs text-stone-500">
            {group.waiterName ? `Garson: ${group.waiterName} · ` : ''}
            {time} · Tablet …{group.deviceId.slice(-4).toUpperCase()}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-orange-100 px-2 py-1 text-xs font-bold text-orange-700">
          {REASON[group.reason] ?? group.reason}
        </span>
      </div>

      <ul className="mt-3 space-y-1 rounded-2xl bg-stone-50 p-3 text-sm">
        {group.lines.length === 0 && (
          <li className="text-stone-500">Kalem yok (yalnız masa açma).</li>
        )}
        {group.lines.map((line) => (
          <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-semibold text-ink-900">
              {formatQty(line.quantity)} × {line.name}
            </span>
            {line.seenPrice !== null &&
              line.currentPrice !== null &&
              line.seenPrice !== line.currentPrice && (
                <span className="text-xs font-bold text-orange-700">
                  Garsonun gördüğü {formatKurus(line.seenPrice)} → şimdi{' '}
                  {formatKurus(line.currentPrice)}
                </span>
              )}
          </li>
        ))}
        {group.submit && (
          <li className="pt-1 text-xs font-bold text-brand-700">
            Garson mutfağa göndermişti: uygulanınca kalemler mutfağa gider.
          </li>
        )}
      </ul>

      {needsTable && (
        <label className="mt-3 block text-sm font-semibold text-stone-600">
          Masa
          <select
            data-testid="review-table-select"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 min-h-12 w-full rounded-xl border border-stone-300 bg-white px-3 text-base text-ink-900"
          >
            {target === PICK && <option value={PICK}>— Masa seçin (asıl masa yok) —</option>}
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.id === group.tableId ? ' (siparişin masası)' : ''}
              </option>
            ))}
            <option value={NO_TABLE}>Masasız (paket / gel-al)</option>
          </select>
          <span className="mt-1 block text-xs font-normal text-stone-500">
            Masada açık adisyon varsa kalemler o adisyona eklenir.
          </span>
        </label>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {group.kind === 'new' && (
          <button
            data-testid="review-apply"
            onClick={() => onResolve('uygula', targetValue)}
            disabled={busy || pickMissing}
            className="min-h-12 rounded-2xl bg-ink-900 px-3 text-sm font-black text-white disabled:opacity-40"
          >
            Siparişi uygula
          </button>
        )}
        {group.kind === 'open' && (
          <button
            data-testid="review-apply"
            onClick={() => onResolve('uygula')}
            disabled={busy}
            className="min-h-12 rounded-2xl bg-ink-900 px-3 text-sm font-black text-white disabled:opacity-40"
          >
            Adisyona ekle (güncel fiyatla)
          </button>
        )}
        {group.kind === 'closed' && (
          <button
            data-testid="review-apply"
            onClick={() => onResolve('yeni_adisyon', targetValue)}
            disabled={busy || pickMissing}
            className="min-h-12 rounded-2xl bg-ink-900 px-3 text-sm font-black text-white disabled:opacity-40"
          >
            Yeni adisyon aç
          </button>
        )}
        {group.kind === 'closed' && group.canReopen && (
          <button
            onClick={() => onResolve('yeniden_ac')}
            disabled={busy}
            className="min-h-12 rounded-2xl border border-stone-300 px-3 text-sm font-bold text-ink-800 disabled:opacity-40"
          >
            Asıl adisyonu yeniden aç
          </button>
        )}
        <button
          data-testid="review-reject"
          onClick={() => void reject()}
          disabled={busy}
          className="min-h-12 rounded-2xl border border-red-200 px-3 text-sm font-bold text-red-700 disabled:opacity-40"
        >
          Reddet
        </button>
      </div>
    </article>
  );
}

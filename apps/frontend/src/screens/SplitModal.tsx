import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatKurus, formatQty } from '../lib/format';
import type { Order, OrderItem } from '../lib/types';
import { useState } from 'react';
import { readHeldOrders, readOpenOrders, readTables } from '../offline/read';

// Adisyon bol: secili kalemler yeni bir adisyona tasinir; kaynakta en az bir kalem kalmali.
// Yeni hesap ayni masada "ayri hesap" (masasiz, kaynak masasiyla etiketlenir) ya da bos bir
// masaya acilir (SAT-20). Bolme sonrasi olusan adisyona yonlenir.
export default function SplitModal({
  orderId,
  items,
  onClose,
  onDone,
}: {
  orderId: string;
  items: OrderItem[];
  onClose: () => void;
  onDone: (createdOrderId: string) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const tables = useQuery({ queryKey: ['tables', 'active'], queryFn: readTables });
  const openOrders = useQuery({ queryKey: ['orders', 'open'], queryFn: readOpenOrders });
  const heldOrders = useQuery({ queryKey: ['orders', 'held'], queryFn: readHeldOrders });
  const busyTables = new Set(
    [...(openOrders.data ?? []), ...(heldOrders.data ?? [])].flatMap((o) =>
      o.tableId ? [o.tableId] : [],
    ),
  );
  const freeTables = (tables.data ?? []).filter((t) => !busyTables.has(t.id));

  const toggle = (itemId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const split = useMutation({
    mutationFn: (itemIds: string[]) =>
      api<{ created: Order }>(`/orders/${orderId}/split`, {
        method: 'POST',
        body: { itemIds, ...(target ? { targetTableId: target } : {}) },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['order', orderId] });
      onDone(res.created.id);
    },
    onError: (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.'),
  });

  const selectedTotal = items
    .filter((it) => selected.has(it.id))
    .reduce((sum, it) => sum + it.lineTotal, 0);
  // Tum kalemler secilemez: kaynakta en az bir kalem kalmali.
  const canSplit = selected.size > 0 && selected.size < items.length && !split.isPending;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div
        data-testid="split-modal"
        className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">Adisyon Böl</h2>
          <button onClick={onClose} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
            Kapat
          </button>
        </div>

        <p className="mb-3 text-sm text-slate-500">Ayrı hesaba taşınacak kalemleri seçin.</p>

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <ul className="mb-4 flex-1 overflow-auto">
          {items.map((it) => {
            const on = selected.has(it.id);
            return (
              <li key={it.id}>
                <button
                  data-testid="split-item"
                  onClick={() => toggle(it.id)}
                  className={`flex min-h-11 w-full items-center justify-between border-b px-2 py-2 text-left ${
                    on ? 'bg-blue-50' : ''
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded border text-xs ${
                        on ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300'
                      }`}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <span className="font-medium text-slate-800">
                      {formatQty(it.quantity)}× {it.productNameSnapshot}
                    </span>
                  </span>
                  <span className="font-semibold text-slate-700">{formatKurus(it.lineTotal)}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <label className="mb-3 block text-sm font-semibold text-slate-600">
          Yeni hesap
          <select
            data-testid="split-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
          >
            <option value="">Aynı masada ayrı hesap</option>
            {freeTables.map((t) => (
              <option key={t.id} value={t.id}>
                Boş masaya taşı: {t.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-500">Seçilen: {formatKurus(selectedTotal)}</span>
          <button
            data-testid="split-submit"
            onClick={() => split.mutate([...selected])}
            disabled={!canSplit}
            className="min-h-11 rounded-lg bg-blue-600 px-5 font-semibold text-white disabled:opacity-40"
          >
            Böl
          </button>
        </div>
      </div>
    </div>
  );
}

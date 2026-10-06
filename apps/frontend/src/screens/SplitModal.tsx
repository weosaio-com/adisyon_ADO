import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatKurus, formatQty } from '../lib/format';
import type { Order, OrderItem } from '../lib/types';
import { useState } from 'react';

// Adisyon bol: secili kalemler yeni (masasiz) bir adisyona tasinir; kaynakta
// en az bir kalem kalmali. Bolme sonrasi olusan adisyona yonlenir (ayri hesap).
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
        body: { itemIds },
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
      <div className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-2xl bg-white p-6 shadow-xl">
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
                  onClick={() => toggle(it.id)}
                  className={`flex w-full items-center justify-between border-b px-2 py-2 text-left ${
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

        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-500">Seçilen: {formatKurus(selectedTotal)}</span>
          <button
            onClick={() => split.mutate([...selected])}
            disabled={!canSplit}
            className="rounded-lg bg-blue-600 px-5 py-2 font-semibold text-white disabled:opacity-40"
          >
            Böl
          </button>
        </div>
      </div>
    </div>
  );
}

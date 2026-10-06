import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatKurus } from '../lib/format';
import type { Order, Table } from '../lib/types';
import { useState } from 'react';

// Taşı: adisyonu BOŞ bir masaya tasir. Birleştir: baska masanin acik adisyonunu
// BU adisyona (hedef) katar, kaynak iptal edilir.
export default function TableTransferModal({
  orderId,
  currentTableId,
  mode,
  onClose,
  onDone,
}: {
  orderId: string;
  currentTableId: string | null;
  mode: 'move' | 'merge';
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const tables = useQuery({
    queryKey: ['tables', 'active'],
    queryFn: () => api<Table[]>('/tables?active=true'),
  });
  const open = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => api<Order[]>('/orders?open=true'),
  });
  const held = useQuery({
    queryKey: ['orders', 'held'],
    queryFn: () => api<Order[]>('/orders?status=held'),
  });

  const openByTable = new Map<string, Order>();
  for (const o of open.data ?? []) if (o.tableId) openByTable.set(o.tableId, o);
  const heldByTable = new Map<string, Order>();
  for (const o of held.data ?? []) if (o.tableId) heldByTable.set(o.tableId, o);

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');

  const move = useMutation({
    mutationFn: (tableId: string) =>
      api(`/orders/${orderId}/move-table`, { method: 'POST', body: { tableId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      onDone();
    },
    onError: fail,
  });
  const merge = useMutation({
    mutationFn: (sourceOrderId: string) =>
      api(`/orders/${orderId}/merge`, { method: 'POST', body: { sourceOrderId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['order', orderId] });
      onDone();
    },
    onError: fail,
  });

  const list = (tables.data ?? []).filter((t) => {
    if (t.id === currentTableId) return false;
    const busy = openByTable.has(t.id) || heldByTable.has(t.id);
    return mode === 'move' ? !busy : openByTable.has(t.id);
  });

  const pending = move.isPending || merge.isPending;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">
            {mode === 'move' ? 'Masa Taşı' : 'Masa Birleştir'}
          </h2>
          <button onClick={onClose} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
            Kapat
          </button>
        </div>

        <p className="mb-3 text-sm text-slate-500">
          {mode === 'move' ? 'Taşınacak boş masayı seçin.' : 'Bu adisyona katılacak masayı seçin.'}
        </p>

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <div className="grid grid-cols-3 gap-2 overflow-auto">
          {list.length === 0 && (
            <p className="col-span-3 py-6 text-center text-slate-400">
              {mode === 'move' ? 'Boş masa yok' : 'Katılacak adisyon yok'}
            </p>
          )}
          {list.map((t) => {
            const o = openByTable.get(t.id);
            return (
              <button
                key={t.id}
                onClick={() => (mode === 'move' ? move.mutate(t.id) : merge.mutate(o!.id))}
                disabled={pending}
                className="flex aspect-square flex-col items-center justify-center rounded-xl bg-slate-100 p-2 font-semibold text-slate-700 disabled:opacity-40"
              >
                <span>{t.name}</span>
                {o && (
                  <span className="mt-1 text-xs text-slate-500">{formatKurus(o.grandTotal)}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

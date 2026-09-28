import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatKurus, parseTlToKurus } from '../lib/format';
import type { Discount } from '../lib/types';

// Adisyon-seviyesi indirim: yuzde (1-100) veya tutar (TL). >%10 backend'de
// Owner (discount.apply_full) yetkisi ister -> yetkisizse DISCOUNT_NEEDS_APPROVAL.
export default function DiscountModal({
  orderId,
  discounts,
  onClose,
}: {
  orderId: string;
  discounts: Discount[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['order', orderId] });
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');

  const apply = useMutation({
    mutationFn: () => {
      // percent: value = yuzde. amount: value = kurus (TL girisinden).
      const v =
        type === 'percent'
          ? Math.round(parseFloat(value.replace(',', '.')))
          : parseTlToKurus(value);
      return api(`/orders/${orderId}/discounts`, { method: 'POST', body: { type, value: v } });
    },
    onSuccess: () => {
      setValue('');
      refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (discountId: string) =>
      api(`/orders/${orderId}/discounts/${discountId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">İndirim</h2>
          <button onClick={onClose} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
            Kapat
          </button>
        </div>

        {discounts.length > 0 && (
          <ul className="mb-4 space-y-1">
            {discounts.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"
              >
                <span className="text-slate-600">
                  {d.type === 'percent' ? `%${d.value}` : 'Tutar'} · {formatKurus(d.amount)}
                </span>
                <button
                  onClick={() => remove.mutate(d.id)}
                  disabled={remove.isPending}
                  className="font-medium text-red-600"
                >
                  Kaldır
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-3 flex rounded-lg bg-slate-100 p-1">
          {(['percent', 'amount'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`flex-1 rounded-md py-2 text-sm font-semibold ${
                type === t ? 'bg-white text-slate-900 shadow' : 'text-slate-500'
              }`}
            >
              {t === 'percent' ? 'Yüzde (%)' : 'Tutar (TL)'}
            </button>
          ))}
        </div>

        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
          placeholder={type === 'percent' ? '10' : '25,00'}
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-3 text-lg"
        />

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <button
          onClick={() => {
            setError('');
            apply.mutate();
          }}
          disabled={apply.isPending || !value.trim()}
          className="w-full rounded-lg bg-blue-600 py-3 text-lg font-semibold text-white disabled:opacity-40"
        >
          Uygula
        </button>
      </div>
    </div>
  );
}

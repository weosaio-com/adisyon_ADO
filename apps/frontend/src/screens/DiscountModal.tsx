import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, isConnectivityError } from '../lib/api';
import { formatKurus, parseTlToKurus } from '../lib/format';
import { ulid } from '../offline/ids';
import type { Discount } from '../lib/types';
import { ReasonPicker } from './ReasonModal';
import { DISCOUNT_REASONS, reasonText } from './reason';
import { keyReuser, moneyLimitError } from './payment-input';

// Adisyon-seviyesi indirim: yuzde (1-100) veya tutar (TL). >%10 backend'de
// Owner (discount.apply_full) yetkisi ister -> yetkisizse DISCOUNT_NEEDS_APPROVAL.
// Gerekce zorunlu (sunucu 400 REASON_REQUIRED); ayni giris tekrar gonderilirse ayni clientOpId
// gider: yaniti kaybolan istek tekrar basilinca ikinci indirim acilmaz.
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
  const [choice, setChoice] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [error, setError] = useState('');
  const [keyFor] = useState(() => keyReuser(ulid));
  const [applied, setApplied] = useState(0);

  const refresh = () => qc.invalidateQueries({ queryKey: ['order', orderId] });
  const fail = (e: unknown) => {
    refresh();
    setError(
      isConnectivityError(e)
        ? 'Bağlantı koptu; indirim kaydedilmiş olabilir. Listeyi kontrol edip gerekirse tekrar deneyin.'
        : e instanceof ApiError
          ? e.message
          : 'İşlem başarısız.',
    );
  };

  // percent: deger = yuzde (tam sayi 1-100). amount: deger = kurus (TL girisinden).
  const parsed =
    type === 'percent' ? Number(value.trim().replace(',', '.')) : parseTlToKurus(value);
  const valueError = !value.trim()
    ? ''
    : type === 'percent'
      ? Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
        ? ''
        : 'Yüzde 1 ile 100 arasında tam sayı olmalıdır.'
      : !Number.isFinite(parsed) || parsed <= 0
        ? 'Geçerli bir tutar girin.'
        : moneyLimitError(parsed);
  const reason = reasonText(choice, other);
  const valid = value.trim() !== '' && !valueError && reason !== '';

  const apply = useMutation({
    mutationFn: () =>
      api(`/orders/${orderId}/discounts`, {
        method: 'POST',
        body: {
          type,
          value: parsed,
          reason,
          clientOpId: keyFor(JSON.stringify([type, parsed, reason, applied])),
        },
      }),
    onSuccess: () => {
      setApplied((n) => n + 1);
      setValue('');
      setChoice(null);
      setOther('');
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-4">
      <div
        data-testid="discount-modal"
        role="dialog"
        aria-modal="true"
        aria-label="İndirim"
        className="max-h-full w-full max-w-sm overflow-auto rounded-3xl bg-white p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-black text-ink-900">İndirim</h2>
          <button
            onClick={onClose}
            className="min-h-11 rounded-xl border border-stone-200 px-4 text-sm font-bold text-stone-600"
          >
            Kapat
          </button>
        </div>

        {discounts.length > 0 && (
          <ul className="mb-4 space-y-2">
            {discounts.map((d) => (
              <li
                key={d.id}
                data-testid="discount-row"
                className="flex items-center justify-between gap-2 rounded-xl bg-stone-50 px-3 py-2 text-sm"
              >
                <span className="min-w-0 text-stone-700">
                  <span className="font-bold">
                    {d.type === 'percent' ? `%${d.value}` : 'Tutar'} · {formatKurus(d.amount)}
                  </span>
                  {d.reason && <span className="block truncate text-xs">{d.reason}</span>}
                </span>
                <button
                  onClick={() => remove.mutate(d.id)}
                  disabled={remove.isPending}
                  className="min-h-11 shrink-0 rounded-xl px-3 font-bold text-red-600 hover:bg-red-50"
                >
                  Kaldır
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mb-3 grid grid-cols-2 gap-1 rounded-2xl bg-stone-100 p-1">
          {(['percent', 'amount'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`min-h-11 rounded-xl text-sm font-bold ${
                type === t ? 'bg-white text-ink-900 shadow' : 'text-stone-500'
              }`}
            >
              {t === 'percent' ? 'Yüzde (%)' : 'Tutar (TL)'}
            </button>
          ))}
        </div>

        <input
          data-testid="discount-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
          placeholder={type === 'percent' ? '10' : '25,00'}
          className="mb-1 min-h-12 w-full rounded-xl border border-stone-300 px-3 text-lg"
        />
        {valueError && <p className="mb-2 text-sm font-medium text-red-600">{valueError}</p>}

        <div className="mt-3 mb-4">
          <ReasonPicker
            label="İndirim nedeni"
            reasons={DISCOUNT_REASONS}
            choice={choice}
            other={other}
            onChoice={setChoice}
            onOther={setOther}
          />
        </div>

        {error && (
          <p role="alert" className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          data-testid="discount-apply"
          onClick={() => {
            setError('');
            apply.mutate();
          }}
          disabled={apply.isPending || !valid}
          className="min-h-14 w-full rounded-2xl bg-ink-900 text-lg font-black text-white disabled:opacity-40"
        >
          {apply.isPending ? 'Uygulanıyor…' : 'Uygula'}
        </button>
      </div>
    </div>
  );
}

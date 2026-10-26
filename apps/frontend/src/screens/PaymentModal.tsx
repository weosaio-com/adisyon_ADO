import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, isConnectivityError } from '../lib/api';
import { formatKurus, parseTlToKurus } from '../lib/format';
import { ulid } from '../offline/ids';
import type { Customer, Order, Payment } from '../lib/types';
import { keyReuser, kurusToInput, moneyLimitError, netPaid, planPayment } from './payment-input';

const METHODS: { key: string; label: string }[] = [
  { key: 'cash', label: 'Nakit' },
  { key: 'card', label: 'Kart' },
  { key: 'transfer', label: 'Havale' },
  { key: 'debt', label: 'Veresiye' },
];

// Odeme yanitindaki odeme satiri (para ustu sunucunun hesabi).
interface ServerPayment {
  idempotencyKey?: string | null;
  change?: number;
}

// Musterinin uzattigi banknotlar (kurus): dokundukca "alinan nakit"e eklenir.
const NOTES = [2000, 5000, 10000, 20000];

// Parcali/split odeme: her odeme kalani azaltir; toplam >= grandTotal olunca
// backend adisyonu tamamlar (status: completed) -> modal kapanir. Nakitte kalandan fazlasi para
// ustu olur (sunucu `change` yazar, ekranda "Tamam"a basilana kadar gorunur); kart/havale/
// veresiyede kalandan fazla tahsilat yapilamaz (sunucu 400 BILL_OVERPAY).
export default function PaymentModal({
  orderId,
  grandTotal,
  onClose,
  onCompleted,
}: {
  orderId: string;
  grandTotal: number;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const qc = useQueryClient();
  const [method, setMethod] = useState('cash');
  const [amountTl, setAmountTl] = useState('');
  const [receivedTl, setReceivedTl] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [error, setError] = useState('');
  // Para ustu (sunucunun yazdigi): kismi odemede de "Tamam"a basilana kadar ekranda kalir.
  const [changeShown, setChangeShown] = useState<{ amount: number; completed: boolean } | null>(
    null,
  );
  // crypto.randomUUID HTTP'de (tablet LAN adresi) yok; ulid her baglamda calisir.
  const [keyFor] = useState(() => keyReuser(ulid));
  // Basarili odeme sayaci: ayni girisle ikinci (yeni) odeme yeni anahtar alsin.
  const [succeeded, setSucceeded] = useState(0);

  const payments = useQuery({
    queryKey: ['payments', orderId],
    queryFn: () => api<Payment[]>(`/orders/${orderId}/payments`),
  });
  // Veresiye (debt) icin musteri secimi zorunlu — backend customerId ister.
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api<Customer[]>('/customers'),
    enabled: method === 'debt',
  });

  const paid = netPaid(payments.data ?? []);
  const remaining = Math.max(0, grandTotal - paid);
  // Girilen tutar yoksa kalanin tamami varsayilir.
  const amountKurus = amountTl.trim() ? parseTlToKurus(amountTl) : remaining;
  const amountValid = Number.isFinite(amountKurus) && amountKurus > 0;
  const isCash = method === 'cash';
  // Alinan nakit bos birakilirsa tam para varsayilir (sunucu received = amount sayar).
  const receivedKurus = isCash && receivedTl.trim() ? parseTlToKurus(receivedTl) : null;
  const receivedShort = receivedKurus !== null && !(receivedKurus >= amountKurus);
  const plan = planPayment({ method, remaining, amount: amountKurus, received: receivedKurus });
  const change = !receivedShort && amountValid ? plan.change : 0;
  const limitError = moneyLimitError(amountKurus) || moneyLimitError(receivedKurus ?? 0);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['payments', orderId] });
    qc.invalidateQueries({ queryKey: ['order', orderId] });
  };

  const pay = useMutation({
    mutationFn: async () => {
      const idempotencyKey = keyFor(
        JSON.stringify([method, amountKurus, receivedKurus, customerId, succeeded]),
      );
      const order = await api<Order & { payments?: ServerPayment[] }>(
        `/orders/${orderId}/payments`,
        {
          method: 'POST',
          body: {
            method,
            // Nakitte kalandan fazlasi para ustu: adisyona kalan, verilen para `received`.
            amount: plan.amount,
            idempotencyKey,
            ...(plan.received !== undefined ? { received: plan.received } : {}),
            ...(method === 'debt' ? { customerId } : {}),
          },
        },
      );
      // Para ustu sunucunun kaydindan (yoksa ekrandaki onizlemeden).
      const mine = order.payments?.find((p) => p.idempotencyKey === idempotencyKey);
      return { order, change: typeof mine?.change === 'number' ? mine.change : change };
    },
    onSuccess: ({ order, change: given }) => {
      setSucceeded((n) => n + 1);
      refresh();
      setAmountTl('');
      setReceivedTl('');
      const completed = order.status === 'completed';
      if (completed) qc.invalidateQueries({ queryKey: ['orders', 'open'] });
      if (given > 0) setChangeShown({ amount: given, completed });
      else if (completed) onCompleted();
    },
    onError: (e) => {
      // Istek sunucuya ulasip cevap kaybolduysa "odenen/kalan" gercek durumu gostersin.
      refresh();
      setError(
        isConnectivityError(e)
          ? 'Bağlantı koptu; ödeme kaydedilmiş olabilir. Ödenen/kalan tutarı kontrol edip gerekirse tekrar basın (aynı ödeme iki kez alınmaz).'
          : e instanceof ApiError
            ? e.message
            : 'Ödeme başarısız.',
      );
    },
  });
  // Kalan 0 ama adisyon acik (iptal/indirim sonrasi): odeme yerine adisyon kapatilir.
  const closeOrder = useMutation({
    mutationFn: () => api(`/orders/${orderId}/close`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders', 'open'] });
      onCompleted();
    },
    onError: (e) => {
      refresh();
      setError(e instanceof ApiError ? e.message : 'Adisyon kapatılamadı.');
    },
  });

  const valid =
    amountValid &&
    !receivedShort &&
    !plan.blocked &&
    !limitError &&
    remaining > 0 &&
    (method !== 'debt' || customerId !== '');

  const addNote = (note: number) => {
    const base = receivedKurus !== null && Number.isFinite(receivedKurus) ? receivedKurus : 0;
    setReceivedTl(kurusToInput(base + note));
  };

  if (changeShown !== null) {
    return (
      <Shell>
        <div className="py-4 text-center" data-testid="pay-done">
          <p className="text-sm font-bold tracking-wide text-brand-700 uppercase">Ödeme alındı</p>
          <p className="mt-4 text-sm text-stone-500">Müşteriye verilecek para üstü</p>
          <p className="mt-1 text-5xl font-black tracking-tight text-ink-900">
            {formatKurus(changeShown.amount)}
          </p>
          {!changeShown.completed && (
            <p
              className="mt-3 text-sm font-semibold text-amber-700"
              data-testid="pay-done-remaining"
            >
              Adisyonda kalan: {formatKurus(remaining)}
            </p>
          )}
          <button
            onClick={() => (changeShown.completed ? onCompleted() : setChangeShown(null))}
            className="mt-8 min-h-14 w-full rounded-2xl bg-ink-900 text-base font-black text-white"
          >
            Tamam
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-black text-ink-900">Ödeme</h2>
        <button
          onClick={onClose}
          className="min-h-10 rounded-xl border border-stone-200 px-3 text-sm font-bold text-stone-600"
        >
          Kapat
        </button>
      </div>

      <div className="mb-4 space-y-1 rounded-2xl bg-stone-50 p-3 text-sm">
        <Row label="Toplam" value={formatKurus(grandTotal)} />
        <Row label="Ödenen" value={formatKurus(paid)} />
        <Row label="Kalan" value={formatKurus(remaining)} bold />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {METHODS.map((m) => (
          <button
            key={m.key}
            data-testid={`pay-method-${m.key}`}
            onClick={() => {
              setMethod(m.key);
              setReceivedTl('');
            }}
            className={`min-h-11 rounded-xl text-sm font-bold transition ${
              method === m.key ? 'bg-ink-900 text-white' : 'bg-stone-100 text-stone-600'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {method === 'debt' && (
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-stone-600">
            Müşteri (veresiye hesabına yazılır)
          </label>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="w-full rounded-xl border border-stone-300 px-3 py-3 text-lg"
          >
            <option value="">— Müşteri seçin —</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {(customers.data ?? []).length === 0 && !customers.isLoading && (
            <p className="mt-1 text-xs text-stone-400">
              Kayıtlı müşteri yok — Veresiye ekranından ekleyin.
            </p>
          )}
        </div>
      )}

      <label className="mb-1 block text-sm font-semibold text-stone-600">
        Adisyondan düşülecek tutar (TL) — boşsa kalanın tamamı
      </label>
      <input
        data-testid="pay-amount"
        value={amountTl}
        onChange={(e) => setAmountTl(e.target.value)}
        inputMode="decimal"
        placeholder={kurusToInput(remaining)}
        className="mb-3 w-full rounded-xl border border-stone-300 px-3 py-3 text-lg"
      />

      {isCash && (
        <div className="mb-3 rounded-2xl border border-stone-200 p-3">
          <label className="mb-1 block text-sm font-semibold text-stone-600">
            Alınan nakit (TL) — müşterinin verdiği para
          </label>
          <input
            data-testid="pay-received"
            value={receivedTl}
            onChange={(e) => setReceivedTl(e.target.value)}
            inputMode="decimal"
            placeholder="Tam para"
            className="w-full rounded-xl border border-stone-300 px-3 py-3 text-lg"
          />
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {NOTES.map((note) => (
              <button
                key={note}
                onClick={() => addNote(note)}
                className="min-h-10 rounded-lg bg-stone-100 text-sm font-bold text-ink-800"
              >
                +{note / 100}
              </button>
            ))}
            <button
              onClick={() => setReceivedTl('')}
              className="min-h-10 rounded-lg bg-stone-100 text-sm font-bold text-stone-500"
            >
              Sil
            </button>
          </div>
          {receivedShort ? (
            Number.isFinite(receivedKurus) && amountValid ? (
              // Banknotlar eklenirken gecici durum: hata degil, kalan miktar.
              <p className="mt-2 text-sm font-semibold text-amber-700">
                Eksik: {formatKurus(amountKurus - (receivedKurus ?? 0))}
              </p>
            ) : (
              <p className="mt-2 text-sm font-semibold text-red-600">Geçersiz tutar.</p>
            )
          ) : (
            change > 0 && (
              <p
                data-testid="pay-change"
                className="mt-2 flex items-baseline justify-between text-ink-900"
              >
                <span className="text-sm font-bold">Para üstü</span>
                <span className="text-2xl font-black">{formatKurus(change)}</span>
              </p>
            )
          )}
        </div>
      )}

      {limitError && <p className="mb-3 text-sm font-medium text-red-600">{limitError}</p>}
      {plan.blocked && (
        <p
          data-testid="pay-overpay"
          className="mb-3 rounded-2xl bg-red-50 p-3 text-sm text-red-800"
        >
          Kalan tutardan ({formatKurus(remaining)}) fazla tahsil edilemez; fazlası yalnız nakitte
          para üstü olarak verilir.
        </p>
      )}
      {isCash && plan.over && !receivedShort && (
        <p className="mb-3 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">
          Kalandan fazlası para üstü olarak verilir; adisyona {formatKurus(plan.amount)} yazılır.
        </p>
      )}
      {payments.isSuccess && remaining <= 0 && (
        <div className="mb-3 rounded-2xl bg-brand-50 p-3 text-sm text-brand-900">
          <p className="font-semibold">Ödeme tamam; adisyonu kapatabilirsiniz.</p>
          <button
            data-testid="pay-close-order"
            onClick={() => {
              setError('');
              closeOrder.mutate();
            }}
            disabled={closeOrder.isPending}
            className="mt-2 min-h-12 w-full rounded-xl bg-brand-700 font-black text-white disabled:opacity-40"
          >
            Adisyonu kapat
          </button>
        </div>
      )}

      {error && <p className="mb-3 text-sm font-medium text-red-600">{error}</p>}

      <button
        data-testid="pay-submit"
        onClick={() => {
          setError('');
          pay.mutate();
        }}
        disabled={pay.isPending || !valid}
        className="min-h-14 w-full rounded-2xl bg-brand-600 text-lg font-black text-white transition hover:bg-brand-700 disabled:opacity-40"
      >
        {amountValid ? `${formatKurus(amountKurus)} Öde` : 'Öde'}
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/40 p-4">
      <div className="max-h-full w-full max-w-md overflow-auto rounded-3xl bg-white p-5 shadow-xl sm:p-6">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? 'font-black text-ink-900' : 'text-stone-600'}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

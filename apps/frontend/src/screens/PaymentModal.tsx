import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatKurus, parseTlToKurus } from '../lib/format';
import { ulid } from '../offline/ids';
import type { Customer, Order, Payment } from '../lib/types';
import { cashChange, keyReuser, kurusToInput, netPaid } from './payment-input';

const METHODS: { key: string; label: string }[] = [
  { key: 'cash', label: 'Nakit' },
  { key: 'card', label: 'Kart' },
  { key: 'transfer', label: 'Havale' },
  { key: 'debt', label: 'Veresiye' },
];

// Musterinin uzattigi banknotlar (kurus): dokundukca "alinan nakit"e eklenir.
const NOTES = [2000, 5000, 10000, 20000];

// Parcali/split odeme: her odeme kalani azaltir; toplam >= grandTotal olunca
// backend adisyonu tamamlar (status: completed) -> modal kapanir.
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
  const [overpayAck, setOverpayAck] = useState(false);
  // Tamamlanan odemede para ustu varsa kasiyer gorsun diye ekranda tutulur.
  const [doneChange, setDoneChange] = useState<number | null>(null);
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
  const change =
    receivedKurus !== null && !receivedShort ? cashChange(amountKurus, receivedKurus) : 0;
  const isOverpay = amountValid && amountKurus > remaining;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['payments', orderId] });
    qc.invalidateQueries({ queryKey: ['order', orderId] });
  };

  const pay = useMutation({
    mutationFn: async () => {
      const order = await api<Order>(`/orders/${orderId}/payments`, {
        method: 'POST',
        body: {
          method,
          amount: amountKurus,
          idempotencyKey: keyFor(
            JSON.stringify([method, amountKurus, receivedKurus, customerId, succeeded]),
          ),
          ...(receivedKurus !== null ? { received: receivedKurus } : {}),
          ...(isOverpay ? { allowOverpay: true } : {}),
          ...(method === 'debt' ? { customerId } : {}),
        },
      });
      return { order, change };
    },
    onSuccess: ({ order, change: given }) => {
      setSucceeded((n) => n + 1);
      refresh();
      setAmountTl('');
      setReceivedTl('');
      setOverpayAck(false);
      if (order.status === 'completed') {
        qc.invalidateQueries({ queryKey: ['orders', 'open'] });
        if (given > 0) setDoneChange(given);
        else onCompleted();
      }
    },
    onError: (e) => {
      // Istek sunucuya ulasip cevap kaybolduysa "odenen/kalan" gercek durumu gostersin.
      refresh();
      setError(e instanceof ApiError ? e.message : 'Ödeme başarısız.');
    },
  });

  const valid =
    amountValid &&
    !receivedShort &&
    (method !== 'debt' || customerId !== '') &&
    (!isOverpay || overpayAck);

  const addNote = (note: number) => {
    const base = receivedKurus !== null && Number.isFinite(receivedKurus) ? receivedKurus : 0;
    setReceivedTl(kurusToInput(base + note));
  };

  if (doneChange !== null) {
    return (
      <Shell>
        <div className="py-4 text-center" data-testid="pay-done">
          <p className="text-sm font-bold tracking-wide text-brand-700 uppercase">Ödeme alındı</p>
          <p className="mt-4 text-sm text-stone-500">Müşteriye verilecek para üstü</p>
          <p className="mt-1 text-5xl font-black tracking-tight text-ink-900">
            {formatKurus(doneChange)}
          </p>
          <button
            onClick={onCompleted}
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
            <p className="mt-2 text-sm font-semibold text-red-600">
              Alınan nakit, düşülecek tutardan az olamaz.
            </p>
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

      {isOverpay && (
        <div className="mb-3 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900">
          {isCash && (
            <div className="mb-2">
              <p>Müşterinin verdiği parayı mı yazdınız? Para üstü ayrıca hesaplanır.</p>
              <button
                onClick={() => {
                  setReceivedTl(amountTl);
                  setAmountTl('');
                  setOverpayAck(false);
                }}
                className="mt-2 min-h-10 rounded-xl bg-amber-900 px-3 text-sm font-bold text-white"
              >
                Alınan nakde taşı
              </button>
            </div>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={overpayAck}
              onChange={(e) => setOverpayAck(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Kalandan <b>{formatKurus(amountKurus - remaining)}</b> fazla tahsilat yapılıyor.
              Onaylıyorum.
            </span>
          </label>
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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink-900/40 p-4">
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

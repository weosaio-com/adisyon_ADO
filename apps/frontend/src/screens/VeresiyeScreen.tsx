import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, getAccess } from '../lib/api';
import { formatKurus, parseTlToKurus as toKurus } from '../lib/format';
import type { Customer } from '../lib/types';

export default function VeresiyeScreen() {
  const nav = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api<Customer[]>('/customers'),
  });

  return (
    <div className="flex h-full flex-col bg-slate-100 md:flex-row">
      <aside className="flex w-full flex-col bg-white shadow md:w-80">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <button
            onClick={() => nav('/')}
            className="rounded-lg bg-slate-200 px-3 py-1 font-medium"
          >
            ← Masalar
          </button>
          <h1 className="font-bold text-slate-800">Veresiye</h1>
          <button
            onClick={() => setNewOpen(true)}
            className="ml-auto rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white"
          >
            + Yeni
          </button>
        </header>
        <ul className="flex-1 overflow-auto">
          {(customers.data ?? []).length === 0 && (
            <li className="p-4 text-center text-slate-400">Müşteri yok</li>
          )}
          {(customers.data ?? []).map((c) => {
            const bal = c.debtAccount?.balance ?? 0;
            return (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c.id)}
                  className={`flex w-full items-center justify-between border-b px-4 py-3 text-left ${
                    selected === c.id ? 'bg-blue-50' : ''
                  }`}
                >
                  <span className="font-medium text-slate-800">{c.name}</span>
                  <span className={`font-semibold ${bal > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                    {formatKurus(bal)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="flex-1 overflow-auto p-4">
        {selected ? (
          <CustomerDetail key={selected} customerId={selected} />
        ) : (
          <p className="p-8 text-center text-slate-400">Soldan bir müşteri seçin.</p>
        )}
      </main>

      {newOpen && (
        <NewCustomerModal onClose={() => setNewOpen(false)} onDone={() => setNewOpen(false)} />
      )}
    </div>
  );
}

function CustomerDetail({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'debt' | 'payment'>('debt');
  const [amountTl, setAmountTl] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);
  const [overpayAck, setOverpayAck] = useState(false);

  const detail = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => api<Customer>(`/customers/${customerId}`),
  });

  const refresh = () => {
    setAmountTl('');
    setNote('');
    setError('');
    setOverpayAck(false);
    qc.invalidateQueries({ queryKey: ['customer', customerId] });
    qc.invalidateQueries({ queryKey: ['customers'] });
  };
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');

  const submit = useMutation({
    mutationFn: (body: {
      amount: number;
      method?: string;
      note?: string;
      allowOverpay?: boolean;
    }) =>
      api(`/customers/${customerId}/${mode === 'debt' ? 'debt' : 'payment'}`, {
        method: 'POST',
        body,
      }),
    onSuccess: refresh,
    onError: fail,
  });

  const kurus = toKurus(amountTl);
  const curBalance = detail.data?.debtAccount?.balance ?? 0;
  // Tahsilatta borctan fazla tahsil ediliyorsa uyari + onay gerekir.
  const isOverpay = mode === 'payment' && Number.isFinite(kurus) && kurus > curBalance;
  const valid =
    amountTl.trim() !== '' && Number.isFinite(kurus) && kurus > 0 && (!isOverpay || overpayAck);
  const doSubmit = () =>
    submit.mutate({
      amount: kurus,
      ...(mode === 'payment' ? { method } : {}),
      ...(isOverpay ? { allowOverpay: true } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });

  async function downloadCsv() {
    setError('');
    setCsvBusy(true);
    try {
      const res = await fetch(`/api/v1/customers/${customerId}/statement.csv`, {
        headers: { Authorization: `Bearer ${getAccess() ?? ''}` },
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ekstre-${customerId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Ekstre indirilemedi.');
    } finally {
      setCsvBusy(false);
    }
  }

  if (detail.isLoading) return <p className="p-8 text-center text-slate-400">Yükleniyor…</p>;
  const c = detail.data;
  if (!c) return null;
  const balance = c.debtAccount?.balance ?? 0;
  const txns = c.debtAccount?.transactions ?? [];

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800">{c.name}</h2>
            {c.phone && <p className="text-sm text-slate-500">{c.phone}</p>}
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">Güncel Borç</p>
            <p className={`text-xl font-bold ${balance > 0 ? 'text-red-600' : 'text-slate-700'}`}>
              {formatKurus(balance)}
            </p>
          </div>
        </div>
        <button
          onClick={downloadCsv}
          disabled={csvBusy}
          className="mt-3 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-40"
        >
          Ekstre (CSV)
        </button>
      </div>

      {/* İşlem */}
      <div className="rounded-2xl bg-white p-4 shadow">
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => setMode('debt')}
            className={`rounded-lg py-2 font-semibold ${mode === 'debt' ? 'bg-red-600 text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            Borç Ekle
          </button>
          <button
            onClick={() => setMode('payment')}
            className={`rounded-lg py-2 font-semibold ${mode === 'payment' ? 'bg-green-600 text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            Tahsilat
          </button>
        </div>
        {mode === 'payment' && (
          <div className="mb-2 grid grid-cols-3 gap-2">
            {['cash', 'card', 'transfer'].map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={`rounded-lg py-1.5 text-sm font-medium ${method === m ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
              >
                {m === 'cash' ? 'Nakit' : m === 'card' ? 'Kart' : 'Havale'}
              </button>
            ))}
          </div>
        )}
        <input
          value={amountTl}
          onChange={(e) => setAmountTl(e.target.value)}
          inputMode="decimal"
          placeholder="Tutar (TL)"
          className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Açıklama (isteğe bağlı)"
          className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2"
        />
        {isOverpay && (
          <label className="mb-2 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            <input
              type="checkbox"
              checked={overpayAck}
              onChange={(e) => setOverpayAck(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Güncel borçtan <b>{formatKurus(kurus - curBalance)}</b> fazla tahsilat yapılıyor.
              Onaylıyorum.
            </span>
          </label>
        )}
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <button
          onClick={doSubmit}
          disabled={submit.isPending || !valid}
          className="w-full rounded-lg bg-slate-700 py-2 font-semibold text-white disabled:opacity-40"
        >
          {mode === 'debt' ? 'Borç Ekle' : 'Tahsilat Al'}
        </button>
      </div>

      {/* Hareketler */}
      <div className="rounded-2xl bg-white p-4 shadow">
        <h3 className="mb-2 font-bold text-slate-800">Hareketler</h3>
        <ul className="divide-y">
          {txns.length === 0 && <li className="py-3 text-sm text-slate-400">Hareket yok</li>}
          {txns.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2 text-sm">
              <span className="text-slate-600">
                {t.type === 'payment' ? 'Tahsilat' : 'Borç'}
                {t.note ? <span className="text-slate-400"> · {t.note}</span> : null}
              </span>
              <span className={`font-semibold ${t.amount < 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatKurus(t.amount)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function NewCustomerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/customers', {
        method: 'POST',
        body: { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Kayıt başarısız.'),
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">Yeni Müşteri</h2>
          <button onClick={onClose} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
            Kapat
          </button>
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ad Soyad"
          className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2"
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Telefon (isteğe bağlı)"
          className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2"
        />
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending || name.trim() === ''}
          className="w-full rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
        >
          Kaydet
        </button>
      </div>
    </div>
  );
}

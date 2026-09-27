import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, hasPerm } from '../lib/api';
import TextPromptModal from '../components/TextPromptModal';
import { ulid } from '../offline/ids';
import { formatKurus, parseTlToKurus as toKurus } from '../lib/format';
import type { CashSession, Order } from '../lib/types';
import { readOpenOrders, readTables } from '../offline/read';
import { pickKasaPanel } from './kasa-panel';

// TL metnini kurusa cevir (PaymentModal ile ayni kalip). Gecersizse NaN.

const TXN_LABELS: Record<string, string> = {
  opening: 'Açılış',
  sale: 'Satış',
  refund: 'İade',
  payout: 'Para Çıkışı',
  income: 'Para Girişi',
  expense: 'Gider',
  adjustment: 'Düzeltme',
  closing: 'Kapanış',
};

export default function KasaScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const session = useQuery<CashSession>({
    queryKey: ['cash', 'active'],
    queryFn: () => api<CashSession>('/cash/sessions/active'),
    retry: false,
  });

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');
  const refresh = () => {
    setError('');
    qc.invalidateQueries({ queryKey: ['cash', 'active'] });
  };

  const panel = pickKasaPanel({
    isError: session.isError,
    errorStatus: session.error instanceof ApiError ? session.error.status : undefined,
    hasData: !!session.data,
  });

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center gap-3 bg-white px-6 py-3 shadow">
        <button onClick={() => nav('/')} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
          ← Masalar
        </button>
        <h1 className="text-lg font-bold text-slate-800">Kasa</h1>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 overflow-auto p-4">
        {error && <p className="mb-3 rounded-lg bg-red-50 p-2 text-sm text-red-600">{error}</p>}

        {session.isLoading && <p className="p-6 text-center text-slate-400">Yükleniyor…</p>}

        {/* Yatay düzen: solda kasa oturumu, sağda açık adisyonlar */}
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <div>
            {panel === 'open' && <OpenForm onDone={refresh} onError={fail} />}
            {panel === 'active' && session.data && (
              <ActiveSession session={session.data} onDone={refresh} onError={fail} />
            )}
          </div>
          <OpenOrdersPanel />
        </div>
      </div>
    </div>
  );
}

// Kasadan açık masalara/adisyonlara erişim: tıkla → sipariş ekranı (kalem
// ekle/çıkar orada, her şey sisteme kaydedilir).
function OpenOrdersPanel() {
  const nav = useNavigate();
  const orders = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: readOpenOrders,
    refetchInterval: 15_000,
  });
  const tables = useQuery({ queryKey: ['tables', 'active'], queryFn: readTables });
  const tableName = (id: string) => tables.data?.find((t) => t.id === id)?.name ?? 'Masa';
  const label = (o: Order) =>
    o.tableId ? tableName(o.tableId) : o.type === 'delivery' ? '🛵 Paket' : '🥡 Gel-Al';
  const list = orders.data ?? [];

  return (
    <div className="mt-6">
      <h2 className="mb-2 text-sm font-semibold text-slate-500">Açık Adisyonlar</h2>
      {list.length === 0 ? (
        <p className="rounded-lg bg-white p-4 text-center text-sm text-slate-400 shadow-sm">
          Açık adisyon yok
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {list.map((o) => (
            <button
              key={o.id}
              onClick={() => nav(`/orders/${o.id}`)}
              className="flex flex-col items-start rounded-xl bg-white p-3 text-left shadow-sm transition active:scale-95"
            >
              <span className="font-semibold text-slate-800">{label(o)}</span>
              <span className="mt-1 text-sm text-slate-500">{formatKurus(o.grandTotal)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenForm({ onDone, onError }: { onDone: () => void; onError: (e: unknown) => void }) {
  const [floatTl, setFloatTl] = useState('');
  const open = useMutation({
    mutationFn: (openingFloat: number) =>
      api('/cash/sessions/open', { method: 'POST', body: { openingFloat } }),
    onSuccess: onDone,
    onError,
  });
  const kurus = toKurus(floatTl);
  const valid = floatTl.trim() !== '' && Number.isFinite(kurus) && kurus >= 0;

  return (
    <div className="rounded-2xl bg-white p-6 shadow">
      <h2 className="mb-1 text-lg font-bold text-slate-800">Kasa Kapalı</h2>
      <p className="mb-4 text-sm text-slate-500">Açılış bakiyesini girip kasayı açın.</p>
      <label className="mb-1 block text-sm font-medium text-slate-600">Açılış Bakiyesi (TL)</label>
      <input
        value={floatTl}
        onChange={(e) => setFloatTl(e.target.value)}
        inputMode="decimal"
        placeholder="0.00"
        className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-3 text-lg"
      />
      <button
        onClick={() => open.mutate(kurus)}
        disabled={open.isPending || !valid}
        className="w-full rounded-lg bg-green-600 py-3 text-lg font-semibold text-white disabled:opacity-40"
      >
        Kasa Aç
      </button>
    </div>
  );
}

function ActiveSession({
  session,
  onDone,
  onError,
}: {
  session: CashSession;
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const [dir, setDir] = useState<'payout' | 'income'>('income');
  const [amountTl, setAmountTl] = useState('');
  const [note, setNote] = useState('');
  const [countTl, setCountTl] = useState('');

  // Beklenen tutar = acilis + acilis/kapanis disi tum hareketler (backend ile ayni).
  const expected =
    session.openingFloat +
    session.transactions
      .filter((t) => t.type !== 'opening' && t.type !== 'closing')
      .reduce((s, t) => s + t.amount, 0);

  const txn = useMutation({
    mutationFn: (body: { type: string; amount: number; method: string; note?: string }) =>
      api('/cash/transactions', { method: 'POST', body }),
    onSuccess: () => {
      setAmountTl('');
      setNote('');
      onDone();
    },
    onError,
  });

  const close = useMutation({
    mutationFn: (countedAmount: number) =>
      api('/cash/sessions/close', { method: 'POST', body: { countedAmount } }),
    onSuccess: onDone,
    onError,
  });

  const moveKurus = toKurus(amountTl);
  const moveValid = amountTl.trim() !== '' && Number.isFinite(moveKurus) && moveKurus > 0;
  const submitMove = () =>
    // payout cekmeceden cikis -> negatif; income giris -> pozitif.
    txn.mutate({
      type: dir,
      amount: dir === 'payout' ? -moveKurus : moveKurus,
      method: 'cash',
      ...(note.trim() ? { note: note.trim() } : {}),
    });

  const countKurus = toKurus(countTl);
  const closeValid = countTl.trim() !== '' && Number.isFinite(countKurus) && countKurus >= 0;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow">
        <div className="flex justify-between text-sm text-slate-600">
          <span>Açılış Bakiyesi</span>
          <span>{formatKurus(session.openingFloat)}</span>
        </div>
        <div className="mt-1 flex justify-between text-lg font-bold text-slate-800">
          <span>Beklenen Nakit</span>
          <span>{formatKurus(expected)}</span>
        </div>
      </div>

      {/* Kasa hareketi ekle */}
      <div className="rounded-2xl bg-white p-4 shadow">
        <h2 className="mb-3 font-bold text-slate-800">Kasa Hareketi</h2>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => setDir('income')}
            className={`rounded-lg py-2 font-semibold ${dir === 'income' ? 'bg-green-600 text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            Para Girişi
          </button>
          <button
            onClick={() => setDir('payout')}
            className={`rounded-lg py-2 font-semibold ${dir === 'payout' ? 'bg-red-600 text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            Para Çıkışı
          </button>
        </div>
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
        <button
          onClick={submitMove}
          disabled={txn.isPending || !moveValid}
          className="w-full rounded-lg bg-slate-700 py-2 font-semibold text-white disabled:opacity-40"
        >
          Ekle
        </button>
      </div>

      <PaymentsPanel />

      {/* Hareketler: yalniz kasa cekmecesi (nakit). Kart/havale ustteki kartta. */}
      <div className="rounded-2xl bg-white p-4 shadow">
        <h2 className="mb-2 font-bold text-slate-800">Kasa Hareketleri (nakit)</h2>
        <ul className="divide-y">
          {session.transactions.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2 text-sm">
              <span className="text-slate-600">
                {TXN_LABELS[t.type] ?? t.type}
                {t.note ? <span className="text-slate-400"> · {t.note}</span> : null}
              </span>
              <span className={`font-semibold ${t.amount < 0 ? 'text-red-600' : 'text-slate-700'}`}>
                {formatKurus(t.amount)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Kasa kapat (Z) */}
      <div className="rounded-2xl bg-white p-4 shadow">
        <h2 className="mb-1 font-bold text-slate-800">Kasa Kapat (Z)</h2>
        <p className="mb-3 text-sm text-slate-500">Sayılan nakit tutarını girin.</p>
        <input
          value={countTl}
          onChange={(e) => setCountTl(e.target.value)}
          inputMode="decimal"
          placeholder="Sayılan Tutar (TL)"
          className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2"
        />
        {countValid(countKurus, countTl) && (
          <p className="mb-2 text-sm text-slate-600">
            Fark:{' '}
            <span className={countKurus - expected < 0 ? 'text-red-600' : 'text-green-600'}>
              {formatKurus(countKurus - expected)}
            </span>
          </p>
        )}
        <button
          onClick={() => close.mutate(countKurus)}
          disabled={close.isPending || !closeValid}
          className="w-full rounded-lg bg-red-600 py-3 font-semibold text-white disabled:opacity-40"
        >
          Kasayı Kapat
        </button>
      </div>
    </div>
  );
}

// Tum para girisi tek yerde: kasa cekmecesi yalnizca NAKDI tutar, kart/havale/
// QR/veresiye hic girmez -> kullanici gunun gercek tahsilatini goremezdi.
// Acik oturumun ozeti zaten /reports/shift'te var; yeni uc acmadan okunur.
const METHOD_LABEL: Record<string, string> = {
  cash: 'Nakit',
  card: 'Kart',
  transfer: 'Havale/EFT',
  qr: 'QR',
  debt: 'Veresiye',
};

interface ShiftPayments {
  payments: { method: string; totalKurus: number }[];
  debtCollectedKurus: number;
  recentPayments: RecentPayment[];
}

interface RecentPayment {
  id: string;
  orderId: string;
  method: string;
  direction: string;
  amountKurus: number;
  paidAt: string;
  orderNo: string;
  reversed: boolean;
  orderPaid: boolean;
}

function PaymentsPanel() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['shift', 'payments'],
    queryFn: () => api<ShiftPayments | null>('/reports/shift'),
    refetchInterval: 30_000,
    retry: false,
  });
  // Yanlis yontem/tutar: odeme iade edilir, adisyon yeniden acilir, dogru odeme alinir.
  // Anahtar pencere acilinca bir kez uretilir: tekrar basma ikinci iade yapmaz.
  const [refundFor, setRefundFor] = useState<{ payment: RecentPayment; key: string } | null>(null);
  const [refunded, setRefunded] = useState<RecentPayment | null>(null);
  const [refundError, setRefundError] = useState('');
  const refund = useMutation({
    mutationFn: ({ reason }: { reason: string }) =>
      api(`/orders/${refundFor!.payment.orderId}/payments/${refundFor!.payment.id}/reverse`, {
        method: 'POST',
        body: { reason, idempotencyKey: refundFor!.key },
      }),
    onSuccess: () => {
      setRefunded(refundFor!.payment);
      setRefundFor(null);
      qc.invalidateQueries({ queryKey: ['shift'] });
      qc.invalidateQueries({ queryKey: ['cash'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => setRefundError(e instanceof ApiError ? e.message : 'İade başarısız.'),
  });
  const canRefund = hasPerm('payment.refund');
  const canReprint = hasPerm('payment.take');
  const [printInfo, setPrintInfo] = useState('');
  const reprint = useMutation({
    mutationFn: (payment: RecentPayment) =>
      api(`/printers/order/${payment.orderId}/receipt`, { method: 'POST' }),
    onSuccess: (_data, payment) => {
      setRefundError('');
      setPrintInfo(
        `#${payment.orderNo.split('-')[1] ?? payment.orderNo} fişi yazıcıya gönderildi.`,
      );
    },
    onError: (e) => {
      setPrintInfo('');
      setRefundError(e instanceof ApiError ? e.message : 'Fiş yazdırılamadı.');
    },
  });
  const d = q.data;
  if (!d) return null;
  const total = d.payments.reduce((s, p) => s + p.totalKurus, 0);

  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <h2 className="mb-2 font-bold text-slate-800">Tahsilat (tüm ödeme türleri)</h2>
      <ul className="mb-3 divide-y">
        {d.payments.length === 0 && <li className="py-2 text-sm text-slate-400">Tahsilat yok</li>}
        {d.payments.map((p) => (
          <li key={p.method} className="flex justify-between py-1.5 text-sm">
            <span className="text-slate-600">{METHOD_LABEL[p.method] ?? p.method}</span>
            <span className="font-semibold text-slate-700">{formatKurus(p.totalKurus)}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-between border-t pt-2 font-bold text-slate-800">
        <span>Toplam</span>
        <span>{formatKurus(total)}</span>
      </div>

      {/* Veresiye tahsilati adisyon odemesi degil (ciro degil, alacak kapanisi);
          bu yuzden toplamin disinda, ayri satirda gosterilir. */}
      {d.debtCollectedKurus > 0 && (
        <div className="mt-2 flex justify-between rounded-lg bg-slate-50 px-2 py-1.5 text-sm">
          <span className="text-slate-500">Veresiye tahsilatı (ciro dışı)</span>
          <span className="font-semibold text-slate-700">{formatKurus(d.debtCollectedKurus)}</span>
        </div>
      )}

      {d.recentPayments.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 text-sm font-semibold text-slate-500">Son işlemler</h3>
          <ul className="divide-y">
            {d.recentPayments.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-1.5 text-sm">
                <span className="text-slate-600">
                  {new Date(p.paidAt).toLocaleTimeString('tr-TR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  <span className="ml-2">{METHOD_LABEL[p.method] ?? p.method}</span>
                  <span className="ml-2 text-slate-400">#{p.orderNo}</span>
                  {p.direction === 'refund' && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-600">
                      İade
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={`font-semibold ${p.direction === 'refund' ? 'text-red-600' : 'text-slate-700'}`}
                  >
                    {p.direction === 'refund' ? '−' : ''}
                    {formatKurus(p.amountKurus)}
                  </span>
                  {canReprint && p.direction === 'charge' && !p.reversed && p.orderPaid && (
                    <button
                      data-testid={`reprint-${p.id}`}
                      onClick={() => reprint.mutate(p)}
                      disabled={reprint.isPending}
                      className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-40"
                    >
                      Fiş
                    </button>
                  )}
                  {canRefund && p.direction === 'charge' && !p.reversed && (
                    <button
                      data-testid={`refund-${p.id}`}
                      onClick={() => {
                        setRefundError('');
                        setRefundFor({ payment: p, key: ulid() });
                      }}
                      className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-600"
                    >
                      İade
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {printInfo && (
        <p className="mt-3 rounded-lg bg-slate-50 p-2 text-sm text-slate-700">{printInfo}</p>
      )}
      {refundError && !refundFor && (
        <p className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-700">{refundError}</p>
      )}

      {refunded && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-green-50 p-2 text-sm text-green-800">
          <span>
            İade yapıldı. #{refunded.orderNo.split('-')[1] ?? refunded.orderNo} adisyonu yeniden
            açıldı; doğru ödemeyi alın. Düzeltilmiş fişi buradaki "Fiş" düğmesiyle basabilirsiniz.
          </span>
          <button
            onClick={() => nav(`/orders/${refunded.orderId}`)}
            className="shrink-0 rounded-lg bg-green-700 px-3 py-1 text-xs font-semibold text-white"
          >
            Adisyonu aç
          </button>
        </div>
      )}

      {refundFor && (
        <TextPromptModal
          title="Ödemeyi iade et"
          description={`${METHOD_LABEL[refundFor.payment.method] ?? refundFor.payment.method} · ${formatKurus(refundFor.payment.amountKurus)} · #${refundFor.payment.orderNo}`}
          label="İade nedeni"
          suggestions={['Yanlış ödeme yöntemi', 'Yanlış tutar', 'Müşteri iadesi']}
          confirmLabel="İade et"
          danger
          busy={refund.isPending}
          error={refundError}
          onConfirm={(reason) => refund.mutate({ reason })}
          onClose={() => setRefundFor(null)}
        />
      )}
    </div>
  );
}

// Fark onizlemesi icin: gecerli sayi girildi mi.
function countValid(kurus: number, raw: string) {
  return raw.trim() !== '' && Number.isFinite(kurus) && kurus >= 0;
}

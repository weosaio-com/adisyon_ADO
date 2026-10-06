import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatKurus, parseTlToKurus } from '../lib/format';
import { downloadCsv } from '../lib/export';
import { ENTITY_LABEL, actionLabel, entryName } from './report-audit';

// --- tipler ---
interface CashSession {
  id: string;
  status: string;
  openingFloatKurus: number;
  expectedKurus: number | null;
  countedKurus: number | null;
  differenceKurus: number | null;
}
interface EndOfDay {
  businessDay: string;
  sales: { count: number; grossKurus: number; discountKurus: number; netKurus: number };
  payments: { method: string; totalKurus: number }[];
  salesByType: { type: string; count: number; netKurus: number }[];
  cash: { sessions: CashSession[]; differenceTotalKurus: number };
  expensesKurus: number;
  incomesKurus: number;
}
interface ShiftReport {
  sessionId: string;
  openedAt: string;
  generatedAt: string;
  openingFloatKurus: number;
  sales: { count: number; grossKurus: number; discountKurus: number; netKurus: number };
  payments: { method: string; totalKurus: number }[];
  salesByType: { type: string; count: number; netKurus: number }[];
  expensesKurus: number;
  incomesKurus: number;
  expectedCashKurus: number;
}
interface EodHistory {
  id: string;
  businessDay: string;
  closedAt: string | null;
  openingFloatKurus: number;
  expectedKurus: number;
  countedKurus: number;
  differenceKurus: number;
}
interface DailySales {
  salesCount: number;
  salesTotalKurus: number;
  discountTotalKurus: number;
  payments: { method: string; totalKurus: number }[];
  salesByType: { type: string; count: number; netKurus: number }[];
  receipts: {
    receiptNo: string;
    type: string;
    orderNo: string;
    printedAt: string;
    totalKurus: number;
  }[];
  categoryBreakdown: { category: string; totalKurus: number }[];
}
interface ProductSales {
  productId: string;
  name: string;
  quantityMilis: number;
  totalKurus: number;
}
interface CustomerDebt {
  customerId: string;
  customerName: string;
  phone: string | null;
  balanceKurus: number;
}
interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  userId: string | null;
  userName: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  origin: string | null;
  createdAt: string;
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Nakit',
  card: 'Kart',
  transfer: 'Havale',
  qr: 'QR',
  debt: 'Veresiye',
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  dine_in: 'Salon (Masa)',
  takeaway: 'Gel-Al',
  delivery: 'Paket (Kurye)',
};

// LOCAL tarih (toISOString UTC'dir: TR'de gece 00-03 arasi gunu kaydirir).
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => localDay(new Date());
const daysAgo = (n: number) => localDay(new Date(Date.now() - n * 86400000));
// Is gunu: 06:00 oncesi dunun gunu (backend businessDay kurali ile ayni).
const businessToday = () => {
  const d = new Date();
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return localDay(d);
};
// Kuruş -> Türk Excel'i için virgüllü ondalık sayı (formatsız): 1500 -> "15,00".
const tl = (kurus: number) => (kurus / 100).toFixed(2).replace('.', ',');
const trDate = (iso: string) => new Date(iso).toLocaleString('tr-TR');
// Aralık uçları LOCAL olmalı: 'Z' eki UTC demektir, TR'de gün 3 saat kayar
// ("bugün" -> bugün 03:00–yarın 02:59). Offset'siz ISO local parse edilir.
const dayStart = (d: string) => `${d}T00:00:00.000`;
const dayEnd = (d: string) => `${d}T23:59:59.999`;

type Tab = 'eod' | 'shift' | 'sales' | 'history' | 'debt' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'shift', label: 'Ara Rapor (X)' },
  { key: 'eod', label: 'Gün Sonu (Z)' },
  { key: 'sales', label: 'Satışlar' },
  { key: 'history', label: 'Gün Sonu Geçmişi' },
  { key: 'debt', label: 'Veresiye Borç' },
  { key: 'audit', label: 'Kayıt Geçmişi' },
];

export default function ReportScreen() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('eod');

  return (
    <div className="min-h-full bg-slate-100">
      <header className="bg-white px-6 py-3 shadow print:hidden">
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav('/')}
            className="rounded-lg bg-slate-200 px-3 py-1 font-medium"
          >
            ← Masalar
          </button>
          <h1 className="text-xl font-bold text-slate-800">Raporlar</h1>
        </div>
        <nav className="mt-3 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === t.key ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 p-6 print:max-w-none print:p-0">
        {tab === 'shift' && <ShiftTab />}
        {tab === 'eod' && <EodTab />}
        {tab === 'sales' && <SalesTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'debt' && <DebtTab />}
        {tab === 'audit' && <AuditTab />}
      </main>
    </div>
  );
}

// Ortak: filtre + çıktı çubuğu (yazdırmada gizli) + yazdırılabilir başlık.
function Toolbar({
  title,
  subtitle,
  onCsv,
  children,
}: {
  title: string;
  subtitle?: string;
  onCsv: () => void;
  children?: React.ReactNode;
}) {
  return (
    <>
      <div className="mb-1 hidden print:block">
        <h2 className="text-lg font-bold">{title}</h2>
        {subtitle && <p className="text-sm text-slate-600">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow print:hidden">
        {children}
        <div className="ml-auto flex gap-2">
          <button
            onClick={onCsv}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            Excel (CSV)
          </button>
          <button
            onClick={() => window.print()}
            className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-medium text-white"
          >
            Yazdır / PDF
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col text-xs font-medium text-slate-500">
      {label}
      {children}
    </label>
  );
}
const inputCls = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-700';

// --- Gün Sonu (Z): tek iş günü ---
// Gün sonu (Z) alma: owner şifresi onayı + sayılan nakit ile kasa oturumunu
// kapatır. Kapanış Z rakamlarını (beklenen/sayılan/fark) sisteme kaydeder.
function EodCloseModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [countedTl, setCountedTl] = useState('');
  const [error, setError] = useState('');

  const submit = useMutation({
    mutationFn: async () => {
      const { ok } = await api<{ ok: boolean }>('/auth/verify-owner', {
        method: 'POST',
        body: { password },
      });
      if (!ok) throw new Error('Owner şifresi hatalı.');
      const countedAmount = parseTlToKurus(countedTl || '0');
      await api('/cash/sessions/close', { method: 'POST', body: { countedAmount } });
    },
    onSuccess: onDone,
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Hata.'),
  });

  const valid = password.trim() !== '' && countedTl.trim() !== '';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-bold text-slate-800">Gün Sonu (Z) Al</h2>
        <p className="mb-4 text-sm text-slate-500">
          Kasa oturumu kapatılır ve Z rakamları kaydedilir. Owner şifresi gerekir.
        </p>
        <label className="mb-1 block text-sm font-medium text-slate-600">Sayılan nakit (TL)</label>
        <input
          value={countedTl}
          onChange={(e) => setCountedTl(e.target.value)}
          inputMode="decimal"
          placeholder="0,00"
          className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-3 text-lg"
        />
        <label className="mb-1 block text-sm font-medium text-slate-600">Owner şifresi</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-3 text-lg"
        />
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="rounded-lg bg-slate-200 py-3 font-semibold">
            Vazgeç
          </button>
          <button
            onClick={() => {
              setError('');
              submit.mutate();
            }}
            disabled={!valid || submit.isPending}
            className="rounded-lg bg-red-600 py-3 font-semibold text-white disabled:opacity-40"
          >
            {submit.isPending ? 'Kapatılıyor…' : 'Onayla ve Kapat'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Ara Rapor (X): acik kasa oturumunun anlik ozeti (kasayi KAPATMAZ) ---
function ShiftTab() {
  const report = useQuery({
    queryKey: ['shift'],
    queryFn: () => api<ShiftReport | null>('/reports/shift'),
    refetchInterval: 30_000,
  });
  const r = report.data;
  const onCsv = () => {
    if (!r) return;
    const rows: (string | number)[][] = [
      ['Oturum açılışı', trDate(r.openedAt)],
      ['Fiş sayısı', r.sales.count],
      ['Brüt', tl(r.sales.grossKurus)],
      ['İndirim', tl(r.sales.discountKurus)],
      ['Net ciro', tl(r.sales.netKurus)],
      ...r.payments.map((p) => [METHOD_LABEL[p.method] ?? p.method, tl(p.totalKurus)]),
      ['Gider', tl(r.expensesKurus)],
      ['Gelir', tl(r.incomesKurus)],
      ['Açılış kasası', tl(r.openingFloatKurus)],
      ['Beklenen nakit', tl(r.expectedCashKurus)],
    ];
    downloadCsv(`ara_rapor_${today()}`, ['Kalem', 'Değer'], rows);
  };

  return (
    <>
      <Toolbar
        title="Ara Rapor (X)"
        subtitle={r ? `Oturum açılışı: ${trDate(r.openedAt)}` : 'Açık kasa oturumu yok'}
        onCsv={onCsv}
      />
      <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-700 print:hidden">
        Ara rapor kasayı <b>kapatmaz</b>. Gün sonunu kapatmak için Gün Sonu (Z) sekmesini kullanın.
      </p>
      {report.isLoading && <p className="text-slate-500">Yükleniyor…</p>}
      {report.isError && <p className="text-red-600">Rapor alınamadı.</p>}
      {!report.isLoading && !r && (
        <p className="rounded-xl bg-white p-4 text-slate-500 shadow">
          Açık kasa oturumu yok. Ara rapor için önce Kasa'dan oturum açın.
        </p>
      )}
      {r && (
        <>
          <Card title="Satış">
            <Line label="Fiş sayısı" value={String(r.sales.count)} />
            <Line label="Brüt" value={formatKurus(r.sales.grossKurus)} />
            <Line label="İndirim" value={`−${formatKurus(r.sales.discountKurus)}`} />
            <Line label="Net ciro" value={formatKurus(r.sales.netKurus)} bold />
          </Card>
          <Card title="Ödeme (yönteme göre)">
            {r.payments.length === 0 && <p className="text-slate-400">Ödeme yok</p>}
            {r.payments.map((p) => (
              <Line
                key={p.method}
                label={METHOD_LABEL[p.method] ?? p.method}
                value={formatKurus(p.totalKurus)}
              />
            ))}
          </Card>
          <Card title="Satış tipi (salon / gel-al / paket)">
            {r.salesByType.length === 0 && <p className="text-slate-400">Satış yok</p>}
            {r.salesByType.map((t) => (
              <Line
                key={t.type}
                label={`${ORDER_TYPE_LABEL[t.type] ?? t.type} (${t.count})`}
                value={formatKurus(t.netKurus)}
              />
            ))}
          </Card>
          <Card title="Gider / Gelir">
            <Line label="Gider" value={`−${formatKurus(r.expensesKurus)}`} />
            <Line label="Gelir" value={formatKurus(r.incomesKurus)} />
          </Card>
          <Card title="Kasa (canlı)">
            <Line label="Açılış kasası" value={formatKurus(r.openingFloatKurus)} />
            <Line label="Beklenen nakit" value={formatKurus(r.expectedCashKurus)} bold />
          </Card>
        </>
      )}
    </>
  );
}

function EodTab() {
  const qc = useQueryClient();
  const [date, setDate] = useState(businessToday());
  const [zOpen, setZOpen] = useState(false);
  const report = useQuery({
    queryKey: ['eod', date],
    queryFn: () => api<EndOfDay>(`/reports/end-of-day?date=${date}`),
  });
  const r = report.data;
  const onCsv = () => {
    if (!r) return;
    const rows: (string | number)[][] = [
      ['Fiş sayısı', r.sales.count],
      ['Brüt', tl(r.sales.grossKurus)],
      ['İndirim', tl(r.sales.discountKurus)],
      ['Net ciro', tl(r.sales.netKurus)],
      ...r.payments.map((p) => [METHOD_LABEL[p.method] ?? p.method, tl(p.totalKurus)]),
      ['Gider', tl(r.expensesKurus)],
      ['Gelir', tl(r.incomesKurus)],
      ['Kasa farkı', tl(r.cash.differenceTotalKurus)],
    ];
    downloadCsv(`gunsonu_${date}`, ['Kalem', 'Değer'], rows);
  };
  return (
    <>
      <Toolbar title="Gün Sonu (Z)" subtitle={r ? `İş günü: ${r.businessDay}` : date} onCsv={onCsv}>
        <Field label="Tarih">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputCls}
          />
        </Field>
        <button
          onClick={() => setZOpen(true)}
          className="self-end rounded-lg bg-red-600 px-4 py-2 font-semibold text-white shadow-sm"
        >
          Gün Sonu (Z) Al
        </button>
      </Toolbar>
      {zOpen && (
        <EodCloseModal
          onClose={() => setZOpen(false)}
          onDone={() => {
            setZOpen(false);
            qc.invalidateQueries({ queryKey: ['eod'] });
            qc.invalidateQueries({ queryKey: ['eod-history'] });
          }}
        />
      )}
      {report.isLoading && <p className="text-slate-500">Yükleniyor…</p>}
      {report.isError && <p className="text-red-600">Rapor alınamadı.</p>}
      {r && (
        <>
          <Card title="Satış">
            <Line label="Fiş sayısı" value={String(r.sales.count)} />
            <Line label="Brüt" value={formatKurus(r.sales.grossKurus)} />
            <Line label="İndirim" value={`−${formatKurus(r.sales.discountKurus)}`} />
            <Line label="Net ciro" value={formatKurus(r.sales.netKurus)} bold />
          </Card>
          <Card title="Ödeme (yönteme göre)">
            {r.payments.length === 0 && <p className="text-slate-400">Ödeme yok</p>}
            {r.payments.map((p) => (
              <Line
                key={p.method}
                label={METHOD_LABEL[p.method] ?? p.method}
                value={formatKurus(p.totalKurus)}
              />
            ))}
          </Card>
          <Card title="Satış tipi (salon / gel-al / paket)">
            {(r.salesByType ?? []).length === 0 && <p className="text-slate-400">Satış yok</p>}
            {(r.salesByType ?? []).map((t) => (
              <Line
                key={t.type}
                label={`${ORDER_TYPE_LABEL[t.type] ?? t.type} (${t.count})`}
                value={formatKurus(t.netKurus)}
              />
            ))}
          </Card>
          <Card title="Kasa oturumları">
            {r.cash.sessions.length === 0 && <p className="text-slate-400">Oturum yok</p>}
            {r.cash.sessions.map((s) => (
              <div key={s.id} className="mb-2 rounded-lg bg-slate-50 p-2 text-sm">
                <Line label="Açılış kasası" value={formatKurus(s.openingFloatKurus)} />
                <Line
                  label="Beklenen"
                  value={s.expectedKurus == null ? '—' : formatKurus(s.expectedKurus)}
                />
                <Line
                  label="Sayılan"
                  value={s.countedKurus == null ? '—' : formatKurus(s.countedKurus)}
                />
                <Line
                  label="Fark"
                  value={s.differenceKurus == null ? '—' : formatKurus(s.differenceKurus)}
                  bold
                />
              </div>
            ))}
            {r.cash.sessions.length > 0 && (
              <Line label="Toplam fark" value={formatKurus(r.cash.differenceTotalKurus)} bold />
            )}
          </Card>
          <Card title="Gider / Gelir">
            <Line label="Gider" value={`−${formatKurus(r.expensesKurus)}`} />
            <Line label="Gelir" value={formatKurus(r.incomesKurus)} />
          </Card>
        </>
      )}
    </>
  );
}

// --- Satışlar: tarih aralığı (özet + kategori + ürün kırılımı) ---
function SalesTab() {
  const [start, setStart] = useState(daysAgo(7));
  const [end, setEnd] = useState(today());
  const range = `start=${dayStart(start)}&end=${dayEnd(end)}`;
  const daily = useQuery({
    queryKey: ['sales-daily', start, end],
    queryFn: () => api<DailySales>(`/reports/sales/daily?${range}`),
  });
  const products = useQuery({
    queryKey: ['sales-products', start, end],
    queryFn: () => api<ProductSales[]>(`/reports/sales/products?${range}`),
  });
  const onCsv = () => {
    const rows = (products.data ?? []).map((p) => [
      p.name,
      (p.quantityMilis / 1000).toString().replace('.', ','),
      tl(p.totalKurus),
    ]);
    downloadCsv(`satislar_${start}_${end}`, ['Ürün', 'Adet', 'Tutar (TL)'], rows);
  };
  const d = daily.data;
  return (
    <>
      <Toolbar title="Satışlar" subtitle={`${start} — ${end}`} onCsv={onCsv}>
        <Field label="Başlangıç">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Bitiş">
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={inputCls}
          />
        </Field>
      </Toolbar>
      {(daily.isLoading || products.isLoading) && <p className="text-slate-500">Yükleniyor…</p>}
      {d && (
        <>
          <Card title="Özet">
            <Line label="Fiş sayısı" value={String(d.salesCount)} />
            <Line label="Toplam satış" value={formatKurus(d.salesTotalKurus)} bold />
            <Line label="İndirim" value={`−${formatKurus(d.discountTotalKurus)}`} />
          </Card>
          <Card title="Ödeme (yönteme göre)">
            {d.payments.length === 0 && <p className="text-slate-400">Ödeme yok</p>}
            {d.payments.map((p) => (
              <Line
                key={p.method}
                label={METHOD_LABEL[p.method] ?? p.method}
                value={formatKurus(p.totalKurus)}
              />
            ))}
          </Card>
          <Card title="Satış tipi (salon / gel-al / paket)">
            {(d.salesByType ?? []).length === 0 && <p className="text-slate-400">Satış yok</p>}
            {(d.salesByType ?? []).map((t) => (
              <Line
                key={t.type}
                label={`${ORDER_TYPE_LABEL[t.type] ?? t.type} (${t.count})`}
                value={formatKurus(t.netKurus)}
              />
            ))}
          </Card>
          <Card title="Kategori kırılımı">
            {d.categoryBreakdown.length === 0 && <p className="text-slate-400">Veri yok</p>}
            {d.categoryBreakdown.map((c) => (
              <Line key={c.category} label={c.category} value={formatKurus(c.totalKurus)} />
            ))}
          </Card>
          <Card title="Basılan fişler (Hesap / Ödendi)">
            {(d.receipts ?? []).length === 0 && <p className="text-slate-400">Fiş yok</p>}
            {(d.receipts ?? []).map((r) => (
              <div key={r.receiptNo} className="flex items-center justify-between py-1 text-sm">
                <span className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                      r.type === 'bill'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-green-100 text-green-700'
                    }`}
                  >
                    {r.type === 'bill' ? 'Hesap' : 'Ödendi'}
                  </span>
                  <span className="text-slate-600">#{r.orderNo}</span>
                  <span className="text-slate-400">
                    {new Date(r.printedAt).toLocaleTimeString('tr-TR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </span>
                <span className="font-medium text-slate-700">{formatKurus(r.totalKurus)}</span>
              </div>
            ))}
          </Card>
        </>
      )}
      <Card title={`Ürün satışları (${products.data?.length ?? 0})`}>
        {(products.data ?? []).length === 0 && <p className="text-slate-400">Satış yok</p>}
        {(products.data ?? []).map((p) => (
          <div
            key={p.productId}
            className="flex justify-between border-b py-1 text-sm last:border-0"
          >
            <span className="text-slate-700">
              {p.name}
              <span className="ml-1 text-xs text-slate-400">×{p.quantityMilis / 1000}</span>
            </span>
            <span className="font-medium text-slate-700">{formatKurus(p.totalKurus)}</span>
          </div>
        ))}
      </Card>
    </>
  );
}

// --- Gün Sonu Geçmişi ---
function HistoryTab() {
  const [start, setStart] = useState(daysAgo(30));
  const [end, setEnd] = useState(today());
  const q = useQuery({
    queryKey: ['eod-history'],
    queryFn: () => api<EodHistory[]>('/reports/end-of-day/history'),
  });
  const rows = useMemo(
    () => (q.data ?? []).filter((s) => s.businessDay >= start && s.businessDay <= end),
    [q.data, start, end],
  );
  const onCsv = () =>
    downloadCsv(
      `gunsonu_gecmis_${start}_${end}`,
      ['İş günü', 'Açılış', 'Beklenen', 'Sayılan', 'Fark'],
      rows.map((s) => [
        s.businessDay,
        tl(s.openingFloatKurus),
        tl(s.expectedKurus),
        tl(s.countedKurus),
        tl(s.differenceKurus),
      ]),
    );
  return (
    <>
      <Toolbar title="Gün Sonu Geçmişi" subtitle={`${start} — ${end}`} onCsv={onCsv}>
        <Field label="Başlangıç">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Bitiş">
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={inputCls}
          />
        </Field>
      </Toolbar>
      {q.isLoading && <p className="text-slate-500">Yükleniyor…</p>}
      {!q.isLoading && rows.length === 0 && (
        <p className="text-slate-400">Bu aralıkta kapatılmış gün sonu yok.</p>
      )}
      {rows.length > 0 && (
        <Card title={`Gün Sonu Geçmişi (${rows.length})`}>
          {rows.map((s) => (
            <div key={s.id} className="mb-2 rounded-lg bg-slate-50 p-2 text-sm">
              <div className="mb-1 flex justify-between font-semibold text-slate-800">
                <span>{s.businessDay}</span>
                <span
                  className={
                    s.differenceKurus === 0
                      ? 'text-slate-500'
                      : s.differenceKurus < 0
                        ? 'text-red-600'
                        : 'text-green-600'
                  }
                >
                  Fark: {formatKurus(s.differenceKurus)}
                </span>
              </div>
              <Line label="Açılış kasası" value={formatKurus(s.openingFloatKurus)} />
              <Line label="Beklenen" value={formatKurus(s.expectedKurus)} />
              <Line label="Sayılan" value={formatKurus(s.countedKurus)} />
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

// --- Veresiye Borç ---
function DebtTab() {
  const [search, setSearch] = useState('');
  const [minTl, setMinTl] = useState('');
  const q = useQuery({
    queryKey: ['customer-debt'],
    queryFn: () => api<CustomerDebt[]>('/reports/customers/debt'),
  });
  const min = parseTlToKurus(minTl) / 100;
  const rows = useMemo(
    () =>
      (q.data ?? []).filter(
        (c) =>
          c.customerName.toLocaleLowerCase('tr').includes(search.toLocaleLowerCase('tr')) &&
          (!Number.isFinite(min) || c.balanceKurus >= min * 100),
      ),
    [q.data, search, min],
  );
  const total = rows.reduce((s, r) => s + r.balanceKurus, 0);
  const onCsv = () =>
    downloadCsv(
      'veresiye_borc',
      ['Müşteri', 'Telefon', 'Borç (TL)'],
      rows.map((c) => [c.customerName, c.phone ?? '', tl(c.balanceKurus)]),
    );
  return (
    <>
      <Toolbar title="Veresiye Borç" subtitle={`${rows.length} müşteri`} onCsv={onCsv}>
        <Field label="İsim ara">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Müşteri"
            className={inputCls}
          />
        </Field>
        <Field label="Min. borç (TL)">
          <input
            value={minTl}
            onChange={(e) => setMinTl(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            className={`${inputCls} w-24`}
          />
        </Field>
      </Toolbar>
      {q.isLoading && <p className="text-slate-500">Yükleniyor…</p>}
      {!q.isLoading && rows.length === 0 && <p className="text-slate-400">Borçlu müşteri yok.</p>}
      {rows.length > 0 && (
        <Card title={`Veresiye Borçlar (${rows.length})`}>
          {rows.map((c) => (
            <div key={c.customerId} className="flex justify-between border-b py-1.5 last:border-0">
              <span className="text-slate-700">
                {c.customerName}
                {c.phone && <span className="ml-1 text-xs text-slate-400">{c.phone}</span>}
              </span>
              <span className="font-semibold text-red-600">{formatKurus(c.balanceKurus)}</span>
            </div>
          ))}
          <Line label="Toplam borç" value={formatKurus(total)} bold />
        </Card>
      )}
    </>
  );
}

// --- Kayıt Geçmişi (Denetim) ---
const VERB_OPTS = [
  { v: '', l: 'Tüm işlemler' },
  { v: 'create', l: 'Eklenenler' },
  { v: 'update', l: 'Değişenler' },
  { v: 'delete', l: 'Silinenler' },
];
const ENTITY_OPTS = [
  '',
  'product',
  'category',
  'unit',
  'tax',
  'order',
  'payment',
  'customer',
  'table',
  'user',
];

function AuditTab() {
  const [entityType, setEntityType] = useState('');
  const [verb, setVerb] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [text, setText] = useState('');

  const params = new URLSearchParams();
  if (entityType) params.set('entityType', entityType);
  if (entityType && verb) params.set('action', `${entityType}.${verb}`);
  if (userId) params.set('userId', userId);
  params.set('from', dayStart(from));
  params.set('to', dayEnd(to));
  params.set('limit', '2000');

  const q = useQuery({
    queryKey: ['audit', entityType, verb, userId, from, to],
    queryFn: () => api<AuditRow[]>(`/audit?${params.toString()}`),
  });

  // Fiil filtresi entityType olmadan da işlesin diye istemcide de süz + metin ara.
  const rows = useMemo(() => {
    const data = q.data ?? [];
    const t = text.toLocaleLowerCase('tr');
    return data.filter((r) => {
      if (verb && !entityType && !r.action.endsWith(`.${verb}`)) return false;
      if (!t) return true;
      const hay =
        `${actionLabel(r)} ${entryName(r)} ${r.userName ?? ''} ${r.reason ?? ''}`.toLocaleLowerCase(
          'tr',
        );
      return hay.includes(t);
    });
  }, [q.data, verb, entityType, text]);

  // Kullanıcı filtresi seçenekleri (görünen kayıtlardan türetilir).
  const users = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of q.data ?? []) if (r.userId) m.set(r.userId, r.userName ?? r.userId);
    return [...m.entries()];
  }, [q.data]);

  const onCsv = () =>
    downloadCsv(
      `kayit_gecmisi_${from}_${to}`,
      ['Tarih', 'İşlem', 'Ad', 'Kullanıcı', 'Sebep'],
      rows.map((r) => [
        trDate(r.createdAt),
        actionLabel(r),
        entryName(r),
        r.userName ?? '',
        r.reason ?? '',
      ]),
    );

  return (
    <>
      <Toolbar
        title="Kayıt Geçmişi"
        subtitle={`${from} — ${to} · ${rows.length} kayıt`}
        onCsv={onCsv}
      >
        <Field label="Tür">
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className={inputCls}
          >
            {ENTITY_OPTS.map((et) => (
              <option key={et || 'all'} value={et}>
                {et === '' ? 'Tümü' : (ENTITY_LABEL[et] ?? et)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="İşlem">
          <select value={verb} onChange={(e) => setVerb(e.target.value)} className={inputCls}>
            {VERB_OPTS.map((o) => (
              <option key={o.v || 'all'} value={o.v}>
                {o.l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kullanıcı">
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls}>
            <option value="">Tümü</option>
            {users.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Başlangıç">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Bitiş">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Ara">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="metin"
            className={inputCls}
          />
        </Field>
      </Toolbar>
      {q.isLoading && <p className="text-slate-500">Yükleniyor…</p>}
      {!q.isLoading && rows.length === 0 && <p className="text-slate-400">Kayıt yok.</p>}
      {rows.length > 0 && (
        <Card title={`Kayıt Geçmişi (${rows.length})`}>
          {rows.map((row) => {
            const name = entryName(row);
            return (
              <div key={row.id} className="border-b py-1.5 last:border-0">
                <div className="flex justify-between">
                  <span className="text-slate-700">
                    {actionLabel(row)}
                    {name && <span className="ml-1 font-medium text-slate-900">“{name}”</span>}
                  </span>
                  <span className="text-xs text-slate-400">{trDate(row.createdAt)}</span>
                </div>
                <p className="text-xs text-slate-400">
                  {row.userName ?? 'sistem'}
                  {row.reason ? ` · ${row.reason}` : ''}
                </p>
              </div>
            );
          })}
        </Card>
      )}
    </>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white p-4 shadow print:shadow-none">
      <h2 className="mb-2 font-semibold text-slate-700">{title}</h2>
      {children}
    </section>
  );
}
function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      className={`flex justify-between py-0.5 ${bold ? 'font-bold text-slate-800' : 'text-slate-600'}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

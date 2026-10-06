import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { readCategories } from '../offline/read';
import type { DiscoveredPrinter, Printer, PrintJobRow, PrintRoute } from '../lib/types';

const DOC_LABELS: Record<string, string> = {
  kitchen: 'Mutfak',
  bar: 'Bar',
  customer: 'Müşteri fişi',
  test_page: 'Test sayfası',
};

const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: 'Sırada', cls: 'bg-slate-100 text-slate-600' },
  printing: { label: 'Yazılıyor', cls: 'bg-sky-100 text-sky-700' },
  done: { label: 'Yazdırıldı', cls: 'bg-green-100 text-green-700' },
  failed: { label: 'Yazdırılamadı', cls: 'bg-red-100 text-red-700' },
};

const SELECT = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm';
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

// Yazici kurulumu: Windows'taki yaziciyi ekle, fis turlerini yonlendir, basilamayani tekrar dene.
export default function PrinterSettingsCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (message: string) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const printers = useQuery({ queryKey: ['printers'], queryFn: () => api<Printer[]>('/printers') });
  const routes = useQuery({
    queryKey: ['printers', 'routes'],
    queryFn: () => api<PrintRoute[]>('/printers/routes'),
  });
  const jobs = useQuery({
    queryKey: ['printers', 'jobs'],
    queryFn: () => api<PrintJobRow[]>('/printers/jobs'),
    // Sirada/yaziliyor fis varken sonuc hizla gorunsun (ör. "Test yazdır" sonrasi).
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === 'queued' || job.status === 'printing')
        ? 2_000
        : 10_000,
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: readCategories });
  // ['printers'] oneki rota ve fis listesini de tazeler.
  const refresh = () => qc.invalidateQueries({ queryKey: ['printers'] });

  const setDefault = useMutation({
    mutationFn: (id: string) =>
      api(`/printers/${id}`, { method: 'PATCH', body: { isDefault: true } }),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/printers/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError,
  });
  const testPrint = useMutation({
    mutationFn: (id: string) => api(`/printers/test-print/${id}`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      onInfo('Test sayfası gönderildi. Sonucu "Son fişler" listesinde görebilirsiniz.');
    },
    onError,
  });

  const list = printers.data ?? [];
  const nameOf = (id: string) => list.find((p) => p.id === id)?.name ?? '—';

  return (
    <div className="rounded-2xl bg-white p-4 shadow" data-testid="printer-card">
      <h2 className="mb-1 font-bold text-slate-800">Yazıcılar</h2>
      <p className="mb-3 text-xs text-slate-500">
        Mutfak fişi, müşteri fişi ve hesap bu yazıcılardan çıkar. Yazıcıyı önce Windows'a kurun,
        sonra buradan ekleyin.
      </p>

      {list.length === 0 && !printers.isLoading && (
        <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">
          Yazıcı tanımlı değil: mutfak fişleri ve müşteri fişleri basılmaz.
        </p>
      )}

      <ul className="mb-3 space-y-2">
        {list.map((p) => (
          <li
            key={p.id}
            data-testid="printer-row"
            className="rounded-lg border border-slate-200 p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-800">{p.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {p.driverId === 'escpos-mock' ? 'Simülasyon (fiş loga yazılır)' : p.address}
                  {' · '}
                  {p.paperWidth} mm
                </p>
              </div>
              {p.isDefault && (
                <span className="shrink-0 rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                  Varsayılan
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <SmallButton onClick={() => testPrint.mutate(p.id)} disabled={testPrint.isPending}>
                Test yazdır
              </SmallButton>
              {!p.isDefault && (
                <SmallButton
                  onClick={() => setDefault.mutate(p.id)}
                  disabled={setDefault.isPending}
                >
                  Varsayılan yap
                </SmallButton>
              )}
              <SmallButton
                danger
                onClick={() => {
                  if (confirm(`"${p.name}" yazıcısı silinsin mi?`)) remove.mutate(p.id);
                }}
                disabled={remove.isPending}
              >
                Sil
              </SmallButton>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <AddPrinterForm
          first={list.length === 0}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
          onCancel={() => setAdding(false)}
          onError={onError}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full rounded-lg bg-blue-600 py-2 font-semibold text-white"
        >
          + Yazıcı ekle
        </button>
      )}

      {list.length > 0 && (
        <RoutesSection
          printers={list}
          routes={routes.data ?? []}
          categories={categories.data ?? []}
          nameOf={nameOf}
          onChanged={refresh}
          onError={onError}
        />
      )}

      <JobsSection jobs={jobs.data ?? []} onChanged={refresh} onError={onError} />
    </div>
  );
}

function AddPrinterForm({
  first,
  onDone,
  onCancel,
  onError,
}: {
  first: boolean;
  onDone: () => void;
  onCancel: () => void;
  onError: (e: unknown) => void;
}) {
  const discovered = useQuery({
    queryKey: ['printers', 'discover'],
    queryFn: () => api<DiscoveredPrinter[]>('/printers/discover'),
    staleTime: 60_000,
  });
  const [pick, setPick] = useState(''); // discovered indeksi | 'manual'
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [paperWidth, setPaperWidth] = useState<'80' | '58'>('80');
  const [isDefault, setIsDefault] = useState(first);

  const found = discovered.data ?? [];
  const chosen = pick !== '' && pick !== 'manual' ? found[Number(pick)] : undefined;
  const manual = pick === 'manual' || (!discovered.isLoading && found.length === 0);

  const save = useMutation({
    mutationFn: () => {
      const target = chosen ?? {
        driverId: 'windows-spooler',
        connection: 'windows_spooler',
        address: address.trim(),
        name: address.trim(),
      };
      return api('/printers', {
        method: 'POST',
        body: {
          name: name.trim() || target.name,
          driverId: target.driverId,
          connection: target.connection,
          address: target.address,
          paperWidth,
          isDefault,
        },
      });
    },
    onSuccess: onDone,
    onError,
  });

  const valid = chosen !== undefined || (manual && address.trim() !== '');

  return (
    <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
      <label className="block text-sm font-medium text-slate-600">Yazıcı</label>
      {discovered.isLoading ? (
        <p className="text-sm text-slate-500">Yüklü yazıcılar aranıyor…</p>
      ) : (
        found.length > 0 && (
          <select
            data-testid="printer-pick"
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
              const next = found[Number(e.target.value)];
              if (next) setName(next.name);
            }}
            className={SELECT}
          >
            <option value="">— Yüklü yazıcılardan seçin —</option>
            {found.map((p, i) => (
              <option key={`${p.driverId}:${p.address}`} value={i}>
                {p.name}
              </option>
            ))}
            <option value="manual">Listede yok, adını elle yazacağım</option>
          </select>
        )
      )}
      {manual && (
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Windows'taki yazıcı adı (ör. EPSON TM-T20II)"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      )}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Görünen ad (ör. Mutfak yazıcısı)"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-600">Kağıt:</span>
        {(['80', '58'] as const).map((w) => (
          <button
            key={w}
            onClick={() => setPaperWidth(w)}
            className={`rounded-lg px-3 py-1 text-sm font-semibold ${
              paperWidth === w ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {w} mm
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Varsayılan yazıcı (yönlendirme yoksa tüm fişler buradan çıkar)
      </label>
      <div className="flex gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={!valid || save.isPending}
          className="flex-1 rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
        >
          Kaydet
        </button>
        <button onClick={onCancel} className="rounded-lg bg-slate-200 px-4 py-2 font-medium">
          Vazgeç
        </button>
      </div>
    </div>
  );
}

// Fis yonlendirme. Sunucu kurali: kalem once kategorisine ozel rotaya, yoksa genel
// mutfak rotasina, o da yoksa varsayilan yaziciya gider. Musteri fisi: rota, yoksa varsayilan.
function RoutesSection({
  printers,
  routes,
  categories,
  nameOf,
  onChanged,
  onError,
}: {
  printers: Printer[];
  routes: PrintRoute[];
  categories: { id: string; name: string }[];
  nameOf: (id: string) => string;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [catId, setCatId] = useState('');
  const [catPrinter, setCatPrinter] = useState('');
  const [catDoc, setCatDoc] = useState<'bar' | 'kitchen'>('bar');

  const general = (doc: string) => routes.find((r) => r.documentType === doc && !r.categoryId);
  const byCategory = routes.filter((r) => r.categoryId);

  // Genel rota degisimi: eskisini kaldir, "varsayilan" disinda yenisini ekle.
  const setGeneral = useMutation({
    mutationFn: async ({ doc, printerId }: { doc: string; printerId: string }) => {
      const existing = general(doc);
      if (existing) await api(`/printers/routes/${existing.id}`, { method: 'DELETE' });
      if (printerId) {
        await api('/printers/routes', { method: 'POST', body: { documentType: doc, printerId } });
      }
    },
    onSuccess: onChanged,
    onError: (e) => {
      onChanged();
      onError(e);
    },
  });
  const addCategory = useMutation({
    mutationFn: () =>
      api('/printers/routes', {
        method: 'POST',
        body: { documentType: catDoc, printerId: catPrinter, categoryId: catId },
      }),
    onSuccess: () => {
      setCatId('');
      onChanged();
    },
    onError,
  });
  const removeRoute = useMutation({
    mutationFn: (id: string) => api(`/printers/routes/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
    onError,
  });

  const printerOptions = (
    <>
      <option value="">Varsayılan yazıcı</option>
      {printers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </>
  );
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '—';

  return (
    <div className="mt-4 border-t pt-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">Hangi fiş nereden çıksın?</h3>
      {(['kitchen', 'customer'] as const).map((doc) => (
        <label key={doc} className="mb-2 block">
          <span className="mb-1 block text-xs text-slate-500">
            {doc === 'kitchen' ? 'Mutfak fişi (tüm ürünler)' : 'Müşteri fişi ve hesap'}
          </span>
          <select
            data-testid={`route-${doc}`}
            value={general(doc)?.printerId ?? ''}
            onChange={(e) => setGeneral.mutate({ doc, printerId: e.target.value })}
            disabled={setGeneral.isPending}
            className={SELECT}
          >
            {printerOptions}
          </select>
        </label>
      ))}

      <p className="mt-3 mb-1 text-xs text-slate-500">
        Kategoriye özel (ör. İçecekler → bar yazıcısı)
      </p>
      <ul className="mb-2 space-y-1">
        {byCategory.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1.5 text-sm"
          >
            <span className="text-slate-700">
              {catName(r.categoryId)} → {nameOf(r.printerId)} ({DOC_LABELS[r.documentType]})
            </span>
            <button
              onClick={() => removeRoute.mutate(r.id)}
              disabled={removeRoute.isPending}
              className="text-xs font-semibold text-red-600"
            >
              Kaldır
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <select value={catId} onChange={(e) => setCatId(e.target.value)} className={SELECT}>
          <option value="">Kategori seçin</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={catPrinter}
          onChange={(e) => setCatPrinter(e.target.value)}
          className={SELECT}
        >
          <option value="">Yazıcı seçin</option>
          {printers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={catDoc}
          onChange={(e) => setCatDoc(e.target.value as 'bar' | 'kitchen')}
          className={SELECT}
        >
          <option value="bar">Bar fişi olarak</option>
          <option value="kitchen">Mutfak fişi olarak</option>
        </select>
        <button
          onClick={() => addCategory.mutate()}
          disabled={!catId || !catPrinter || addCategory.isPending}
          className="rounded-lg bg-slate-800 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          Ekle
        </button>
      </div>
    </div>
  );
}

function JobsSection({
  jobs,
  onChanged,
  onError,
}: {
  jobs: PrintJobRow[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const retry = useMutation({
    mutationFn: (id: string) => api(`/printers/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: onChanged,
    onError,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api(`/printers/jobs/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
    onError,
  });

  return (
    <div className="mt-4 border-t pt-3" data-testid="print-jobs">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">Son fişler (24 saat)</h3>
      {jobs.length === 0 && <p className="text-sm text-slate-400">Henüz fiş yok.</p>}
      <ul className="space-y-1.5">
        {jobs.slice(0, 15).map((job) => {
          const badge = JOB_STATUS[job.status] ?? JOB_STATUS.queued!;
          return (
            <li key={job.id} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-slate-700">
                  <span className="text-slate-400">{fmtTime(job.createdAt)}</span>{' '}
                  {job.summary || DOC_LABELS[job.documentType]}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${badge.cls}`}
                >
                  {badge.label}
                </span>
              </div>
              <p className="text-xs text-slate-400">{job.printerName}</p>
              {job.status === 'failed' && (
                <>
                  {job.lastError && (
                    <p className="mt-1 text-xs break-words text-red-600">{job.lastError}</p>
                  )}
                  <div className="mt-1 flex gap-2">
                    <SmallButton onClick={() => retry.mutate(job.id)} disabled={retry.isPending}>
                      Tekrar dene
                    </SmallButton>
                    <SmallButton
                      onClick={() => dismiss.mutate(job.id)}
                      disabled={dismiss.isPending}
                    >
                      Kaldır
                    </SmallButton>
                  </div>
                </>
              )}
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-slate-500">Önizle</summary>
                <pre className="mt-1 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs whitespace-pre-wrap text-slate-700">
                  {job.text.trim()}
                </pre>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${
        danger ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, LONG_REQUEST_TIMEOUT_MS } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';

// GET /storage ve POST /storage/cleanup yanitlari (backend: maintenance/maintenance.service.ts).
interface CleanupSummary {
  at: string;
  trigger: 'schedule' | 'manual';
  lowDisk: boolean;
  deleted: {
    backups: number;
    cloudCopies: number;
    backgroundJobs: number;
    printJobs: number;
    clientOps: number;
    sessions: number;
    images: number;
    tempFiles: number;
    preRestoreFiles: number;
  };
  freedBytes: number;
  errors: number;
}

interface StorageInfo {
  dbBytes: number;
  backups: { count: number; totalBytes: number };
  imagesBytes: number;
  logsBytes: number;
  freeDiskBytes: number | null;
  totalDiskBytes: number | null;
  lowDisk: boolean;
  lastCleanup: CleanupSummary | null;
}

// Temizlik ozeti tek satirda: kac sey silindi, kac eski yedek, ne kadar yer acildi.
function cleanupText(summary: CleanupSummary): string {
  const count = Object.values(summary.deleted).reduce((sum, n) => sum + n, 0);
  const parts = [count > 0 ? `${count} eski kayıt/dosya silindi` : 'silinecek bir şey yoktu'];
  if (summary.deleted.backups > 0) parts.push(`${summary.deleted.backups} eski yedek`);
  if (summary.freedBytes > 0) parts.push(`${formatBytes(summary.freedBytes)} boşaldı`);
  if (summary.errors > 0) parts.push(`${summary.errors} işlem sonraya kaldı`);
  return parts.join(' · ');
}

// Depolama kartı (Faz A / A1): veritabanı ve yedek boyutu, boş disk, son temizlik, elle temizlik.
export default function StorageCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (m: string) => void;
}) {
  const qc = useQueryClient();
  const storage = useQuery({
    queryKey: ['storage'],
    queryFn: () => api<StorageInfo>('/storage'),
  });
  // Temizlik eski yedekleri de siler (bulut klasoru dahil); uzun surebilir.
  const cleanup = useMutation({
    mutationFn: () =>
      api<CleanupSummary>('/storage/cleanup', {
        method: 'POST',
        timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      }),
    onSuccess: (summary) => {
      onInfo(`Temizlik tamamlandı: ${cleanupText(summary)}.`);
      void qc.invalidateQueries({ queryKey: ['storage'] });
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError,
  });

  const info = storage.data;
  const free = info?.freeDiskBytes ?? null;
  const total = info?.totalDiskBytes ?? null;
  const usedPercent =
    free !== null && total ? Math.min(100, Math.max(0, 100 - (free / total) * 100)) : null;

  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-bold text-slate-800">Depolama</h2>
        <button
          onClick={() => cleanup.mutate()}
          disabled={cleanup.isPending}
          className="rounded-lg bg-slate-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
        >
          {cleanup.isPending ? 'Temizleniyor…' : 'Şimdi temizle'}
        </button>
      </div>
      {storage.isLoading && <p className="text-sm text-slate-400">Yükleniyor…</p>}
      {storage.isError && <p className="text-sm text-red-600">Depolama bilgisi okunamadı.</p>}
      {info && (
        <>
          {info.lowDisk && (
            <p
              role="alert"
              className="mb-2 rounded-lg bg-red-50 p-2 text-sm font-medium text-red-700"
            >
              Diskte yer azaldı. Eski yedekler daha sıkı temizleniyor: her türden yalnız en yeni
              yedekler kalır. Bilgisayardaki gereksiz dosyaları silin ya da daha büyük bir disk
              kullanın.
            </p>
          )}
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-500">Veritabanı</dt>
            <dd className="text-right text-slate-800">{formatBytes(info.dbBytes)}</dd>
            <dt className="text-slate-500">Yedekler</dt>
            <dd className="text-right text-slate-800">
              {info.backups.count} adet · {formatBytes(info.backups.totalBytes)}
            </dd>
            <dt className="text-slate-500">Ürün görselleri</dt>
            <dd className="text-right text-slate-800">{formatBytes(info.imagesBytes)}</dd>
            <dt className="text-slate-500">Kayıt dosyaları</dt>
            <dd className="text-right text-slate-800">{formatBytes(info.logsBytes)}</dd>
            <dt className="text-slate-500">Boş disk alanı</dt>
            <dd
              className={`text-right ${info.lowDisk ? 'font-semibold text-red-700' : 'text-slate-800'}`}
            >
              {free !== null && total
                ? `${formatBytes(free)} / ${formatBytes(total)} (%${Math.round((free / total) * 100)} boş)`
                : 'bilinmiyor'}
            </dd>
          </dl>
          {usedPercent !== null && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
              <div
                className={`h-full ${info.lowDisk ? 'bg-red-500' : 'bg-slate-500'}`}
                style={{ width: `${usedPercent.toFixed(1)}%` }}
              />
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">
            {info.lastCleanup
              ? `Son temizlik: ${formatDateTime(info.lastCleanup.at)} · ${cleanupText(info.lastCleanup)}`
              : 'Henüz temizlik yapılmadı.'}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Her gün 05:30'da kendiliğinden temizlenir: eski yedekler (akıllı saklama), eski teknik
            kayıtlar ve artık dosyalar silinir. Satış, ödeme, kasa, müşteri ve denetim kayıtlarına
            dokunulmaz.
          </p>
        </>
      )}
    </div>
  );
}

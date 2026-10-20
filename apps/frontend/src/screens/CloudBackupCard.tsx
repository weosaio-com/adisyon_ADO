import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, LONG_REQUEST_TIMEOUT_MS } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';

// Backend: apps/backend/src/cloud-backup/cloud-backup.service.ts (CloudBackupStatus).
interface CloudBackupStatus {
  configured: boolean;
  switchedOn: boolean;
  enabled: boolean;
  linked: boolean;
  lastUploadedAt: string | null;
  lastBackupId: string | null;
  lastSizeBytes: number | null;
  pending: number;
  uploading: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}

// Lisans kartıyla aynı sorgu (yalnız durum gerekli).
interface LicenseState {
  state: 'none' | 'active' | 'grace' | 'expired';
}

type View = 'off' | 'not_licensed' | 'no_license' | 'not_linked' | 'uploading' | 'error' | 'ok';

function viewOf(s: CloudBackupStatus, license: LicenseState['state'] | undefined): View {
  if (!s.switchedOn) return 'off';
  if (!s.enabled) return 'not_licensed';
  if (!s.linked) return license === 'none' ? 'no_license' : 'not_linked';
  if (s.uploading) return 'uploading';
  if (s.lastError) return 'error';
  return 'ok';
}

const NOTE = 'mt-2 rounded-lg p-2 text-sm';
// Bu kadar eski son bulut yedeği uyarı gösterir (internet uzun süredir yok olabilir).
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

// Bulut yedeği: yerel yedeklerin şifreli kopyası buluta gider (yeni bilgisayarda geri yüklenir).
export default function CloudBackupCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (m: string) => void;
}) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['cloud-backups', 'status'],
    queryFn: () => api<CloudBackupStatus>('/cloud-backups/status'),
    // Yükleme sürerken sık, bekleyen varken ara ara, yoksa seyrek yokla.
    refetchInterval: (query) =>
      query.state.data?.uploading ? 2000 : query.state.data?.pending ? 15_000 : 60_000,
  });
  const license = useQuery({
    queryKey: ['license'],
    queryFn: () => api<LicenseState>('/license'),
  });
  const apply = (next: CloudBackupStatus) => qc.setQueryData(['cloud-backups', 'status'], next);

  // Önce yeni bir yerel yedek alınır (en güncel veri), sonra beklemeden buluta yüklenir.
  // Yedek alma uzun sürebilir: normal istek süresi uygulanmaz.
  const backupNow = useMutation({
    mutationFn: async () => {
      await api('/backups', { method: 'POST', timeoutMs: LONG_REQUEST_TIMEOUT_MS });
      return api<CloudBackupStatus>('/cloud-backups/upload-now', {
        method: 'POST',
        timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      });
    },
    onSuccess: (next) => {
      apply(next);
      qc.invalidateQueries({ queryKey: ['backups'] });
      onInfo('Yedek alındı; buluta yükleniyor.');
    },
    onError,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<CloudBackupStatus>('/cloud-backups/settings', { method: 'PUT', body: { enabled } }),
    onSuccess: (next) => {
      apply(next);
      onInfo(
        next.switchedOn ? 'Otomatik bulut yedeği açıldı.' : 'Otomatik bulut yedeği kapatıldı.',
      );
    },
    onError,
  });

  const s = status.data;
  // Bu kurulumda bulut tanımlı değilse (derleme profili) kart görünmez.
  if (!s?.configured) return null;
  const view = viewOf(s, license.data?.state);
  const canUpload = s.enabled && s.linked;
  const stale =
    view === 'ok' &&
    (s.lastUploadedAt
      ? Date.now() - new Date(s.lastUploadedAt).getTime() > STALE_MS
      : s.pending > 0);

  let note: React.ReactNode = null;
  switch (view) {
    case 'off':
      note = (
        <p className={`${NOTE} bg-slate-50 text-slate-600`}>
          Otomatik bulut yedeği bu bilgisayarda kapalı.
        </p>
      );
      break;
    case 'not_licensed':
      note = (
        <p className={`${NOTE} bg-amber-50 text-amber-900`}>
          Lisansınız bulut yedeğini içermiyor. Satıcınızla görüşün.
        </p>
      );
      break;
    case 'no_license':
      note = (
        <p className={`${NOTE} bg-slate-50 text-slate-700`}>
          Bulut yedeği için önce aşağıdaki <b>Lisans</b> bölümünden lisansınızı girin.
        </p>
      );
      break;
    case 'not_linked':
      note = (
        <p className={`${NOTE} bg-amber-50 text-amber-900`} data-testid="cloud-backup-not-linked">
          Bu bilgisayar buluta bağlı değil. Bağlantı kurulunca yedekler kendiliğinden yüklenir.
        </p>
      );
      break;
    case 'uploading':
      note = (
        <p className={`${NOTE} bg-blue-50 text-blue-800`} data-testid="cloud-backup-uploading">
          Buluta yükleniyor…
        </p>
      );
      break;
    case 'error':
      note = (
        <p className={`${NOTE} bg-red-50 text-red-700`} data-testid="cloud-backup-error">
          Son deneme başarısız{s.lastErrorAt ? ` (${formatDateTime(s.lastErrorAt)})` : ''}:{' '}
          {s.lastError} Kendiliğinden yeniden denenecek.
        </p>
      );
      break;
    case 'ok':
      if (stale) {
        note = (
          <p className={`${NOTE} bg-amber-50 text-amber-900`}>
            Son bulut yedeği 2 günden eski. İnternet bağlantısını kontrol edin.
          </p>
        );
      }
      break;
  }

  return (
    <div className="rounded-2xl bg-white p-4 shadow" data-testid="cloud-backup-card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-bold text-slate-800">Bulut Yedeği</h2>
        {canUpload && (
          <button
            onClick={() => backupNow.mutate()}
            disabled={backupNow.isPending || s.uploading}
            className="rounded-lg bg-slate-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
            data-testid="cloud-backup-now"
          >
            {backupNow.isPending ? 'Yedek alınıyor…' : 'Şimdi buluta yedekle'}
          </button>
        )}
      </div>
      <p className="text-sm text-slate-600" data-testid="cloud-backup-last">
        {s.lastUploadedAt ? (
          <>
            Son bulut yedeği: {formatDateTime(s.lastUploadedAt)}
            {s.lastSizeBytes !== null && (
              <span className="text-slate-400"> · {formatBytes(s.lastSizeBytes)}</span>
            )}
          </>
        ) : (
          'Henüz bulut yedeği yok.'
        )}
      </p>
      {note}
      {canUpload && s.pending > 0 && view !== 'uploading' && (
        <p className="mt-1 text-xs text-slate-500">{s.pending} yedek buluta yüklenmeyi bekliyor.</p>
      )}
      <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={s.switchedOn}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        Otomatik bulut yedeği (yeni yedekler buluta da yüklenir)
      </label>
      <p className="mt-2 text-xs text-slate-400">
        Yedekler buluta işletmenizin kendi anahtarıyla şifrelenmiş olarak gider; bulut içeriği
        okuyamaz. Başka bir bilgisayarda geri yüklemek için Yedekler bölümündeki kurtarma anahtarı
        gerekir.
      </p>
    </div>
  );
}

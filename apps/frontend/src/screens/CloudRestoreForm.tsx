import { useState } from 'react';
import { api, ApiError, LONG_REQUEST_TIMEOUT_MS } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';

// Backend: POST /cloud-backups/setup/list yanıtındaki yedek (indirme adresi ekrana gelmez).
interface CloudBackupItem {
  id: string;
  posBackupId: string;
  type: 'auto' | 'manual' | 'pre_update';
  format: 1 | 2;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  uploadedAt: string | null;
}

const TYPE_LABELS: Record<CloudBackupItem['type'], string> = {
  auto: 'Otomatik',
  manual: 'Elle',
  pre_update: 'Güncelleme öncesi',
};

const INPUT =
  'w-full rounded-xl border border-stone-200 bg-white px-3 text-base font-medium text-ink-900 shadow-sm placeholder:text-stone-400';
const LABEL = 'mb-1.5 block text-xs font-bold tracking-wide text-stone-600 uppercase';
const PRIMARY =
  'mt-6 min-h-13 w-full rounded-2xl bg-ink-900 font-black text-white disabled:opacity-40';

const message = (value: unknown, fallback: string) =>
  value instanceof ApiError ? value.message : fallback;

// Yeni bilgisayar, ilk kurulum: lisans anahtarıyla buluttaki yedekleri listeler, seçilen yedeği
// kurtarma anahtarıyla geri yükler (tüm veriler, kullanıcılar dahil). Yalnız ana bilgisayarda.
// Bulut bağlantısı burada kurulmaz; geri yüklenen veritabanının lisansıyla sonra kendiliğinden kurulur.
export default function CloudRestoreForm({ onBack }: { onBack: () => void }) {
  const [licenseKey, setLicenseKey] = useState('');
  const [backups, setBackups] = useState<CloudBackupItem[] | null>(null);
  const [selected, setSelected] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function list(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ backups: CloudBackupItem[] }>('/cloud-backups/setup/list', {
        method: 'POST',
        body: { licenseKey: licenseKey.trim() },
        timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      });
      setBackups(result.backups);
      setSelected(result.backups[0]?.id ?? '');
    } catch (value) {
      setError(message(value, 'Buluttaki yedekler alınamadı.'));
    } finally {
      setBusy(false);
    }
  }

  async function restore(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      // Buluttan indirme + geri yukleme dakikalar surebilir: normal istek suresi uygulanmaz.
      await api('/cloud-backups/setup/restore', {
        method: 'POST',
        body: {
          licenseKey: licenseKey.trim(),
          cloudBackupId: selected,
          recoveryKey: recoveryKey.trim(),
        },
        timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      });
      setDone(true);
    } catch (value) {
      setError(message(value, 'Geri yükleme başarısız.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col justify-center p-6 sm:p-10 lg:p-12">
      <p className="text-[11px] font-bold tracking-[0.18em] text-brand-700 uppercase">
        Buluttan geri yükle
      </p>
      <h1 className="mt-2 text-3xl font-black tracking-tight text-ink-900">
        Verilerinizi buluttan alın
      </h1>
      {done ? (
        <p
          className="mt-4 rounded-xl bg-brand-50 p-3 text-sm leading-6 text-brand-700"
          data-testid="cloud-restore-done"
        >
          Yedek hazırlandı. Uygulamayı kapatıp yeniden açın; ardından eski kullanıcı adı ve
          şifrenizle giriş yapın.
        </p>
      ) : backups === null ? (
        <form onSubmit={list}>
          <p className="mt-2 text-sm leading-6 text-stone-500">
            Eski bilgisayardaki yedekler otomatik olarak buluta yüklendiyse lisans anahtarınızla
            listeleyip geri yükleyebilirsiniz.
          </p>
          <label className="mt-7 block">
            <span className={LABEL}>Lisans anahtarı</span>
            <textarea
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              rows={4}
              placeholder="ADO1.…"
              autoCapitalize="none"
              spellCheck={false}
              className={`${INPUT} py-2 font-mono text-sm break-all`}
              data-testid="cloud-restore-license"
            />
          </label>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy || licenseKey.trim().length < 20}
            className={PRIMARY}
            data-testid="cloud-restore-list"
          >
            {busy ? 'Buluta bağlanılıyor…' : 'Buluttaki yedekleri listele'}
          </button>
        </form>
      ) : (
        <form onSubmit={restore}>
          {backups.length === 0 ? (
            <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-800">
              Bu lisansla bulutta yedek bulunamadı.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm leading-6 text-stone-500">
                Geri yüklenecek yedeği seçin (en yenisi en üstte).
              </p>
              <ul className="mt-4 max-h-56 divide-y divide-stone-100 overflow-auto rounded-xl border border-stone-200">
                {backups.map((backup) => (
                  <li key={backup.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <input
                        type="radio"
                        name="cloud-backup"
                        checked={selected === backup.id}
                        onChange={() => setSelected(backup.id)}
                      />
                      <span className="min-w-0 flex-1 font-medium text-ink-900">
                        {formatDateTime(backup.createdAt)}
                      </span>
                      <span className="text-stone-500">
                        {TYPE_LABELS[backup.type] ?? backup.type} · {formatBytes(backup.sizeBytes)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <label className="mt-5 block">
                <span className={LABEL}>Kurtarma anahtarı</span>
                <input
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  placeholder="xxxx-xxxx-xxxx-…"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={`${INPUT} h-12 font-mono`}
                  data-testid="cloud-restore-recovery-key"
                />
              </label>
              <p className="mt-2 text-xs leading-5 text-stone-500">
                Yedekler eski bilgisayarın anahtarıyla şifrelidir. Anahtar, eski bilgisayarda
                Ayarlar › Yedekler bölümünde gösterilir.
              </p>
            </>
          )}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          {backups.length > 0 && (
            <button
              type="submit"
              disabled={busy || !selected || recoveryKey.trim().length < 16}
              className={PRIMARY}
              data-testid="cloud-restore-submit"
            >
              {busy ? 'İndiriliyor ve geri yükleniyor…' : 'Yedeği geri yükle'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setBackups(null);
              setError('');
            }}
            disabled={busy}
            className="mt-4 w-full text-sm font-semibold text-stone-500 hover:text-ink-900"
          >
            Başka lisans anahtarı gir
          </button>
        </form>
      )}
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="mt-4 w-full text-sm font-semibold text-stone-500 hover:text-ink-900"
      >
        ← Yeni kuruluma dön
      </button>
    </div>
  );
}

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiUpload, ApiError, hasPerm } from '../lib/api';
import { downloadText } from '../lib/export';
import { formatBytes, formatDateTime } from '../lib/format';
import type { AppSetting, Backup } from '../lib/types';

const BACKUP_TYPE_LABELS: Record<string, string> = {
  auto: 'Otomatik',
  manual: 'Elle',
  pre_update: 'Güncelleme Öncesi',
  imported: 'Dışarıdan',
};

// Yedek bu kurulumun anahtarıyla açılmıyor -> kurtarma anahtarı sorulur.
const KEY_ERRORS = ['BACKUP_KEY_REQUIRED', 'BACKUP_DECRYPT_FAILED'];

// Yerel yedekler: al, dosyadan geri yükle, bulut klasörü, günlük otomatik yedek, kurtarma anahtarı.
export default function BackupCard({
  onError,
  onInfo,
}: {
  onError: (e: unknown) => void;
  onInfo: (m: string) => void;
}) {
  const qc = useQueryClient();

  const backups = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<Backup[]>('/backups'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['backups'] });

  // Bulut klasoru + otomatik yedek ayarlari (settings.manage gerektirir).
  const canSettings = hasPerm('settings.manage');
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<AppSetting[]>('/settings'),
    enabled: canSettings,
  });
  const cloudDirSaved =
    (settings.data?.find((s) => s.key === 'backup.cloudDir')?.value as string) || '';
  const autoDaily = settings.data?.find((s) => s.key === 'backup.autoDaily')?.value !== false;
  const [cloudDraft, setCloudDraft] = useState<string | null>(null);
  const saveSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }),
    onSuccess: () => {
      setCloudDraft(null);
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError,
  });

  const create = useMutation({
    mutationFn: () => api<{ cloudCopied?: boolean }>('/backups', { method: 'POST' }),
    onSuccess: (r) => {
      if (cloudDirSaved && !r.cloudCopied)
        onError(new ApiError(0, 'CLOUD_COPY', 'Yedek alındı ama bulut klasörüne kopyalanamadı.'));
      else onInfo(r.cloudCopied ? 'Yedek alındı ve bulut klasörüne kopyalandı.' : 'Yedek alındı.');
      refresh();
    },
    onError,
  });
  // Başka kurulumun yedeği bu anahtarla açılmazsa kurtarma anahtarı sorulur.
  const [keyPrompt, setKeyPrompt] = useState<{ id: string; message: string } | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');
  const restore = useMutation({
    mutationFn: ({ id, recoveryKey }: { id: string; recoveryKey?: string }) =>
      api<{ message: string }>(`/backups/${id}/restore`, {
        method: 'POST',
        body: recoveryKey ? { recoveryKey } : {},
      }),
    onSuccess: (r) => {
      setKeyPrompt(null);
      setRecoveryKey('');
      onInfo(r.message);
    },
    onError: (e, vars) => {
      if (e instanceof ApiError && KEY_ERRORS.includes(e.code)) {
        setKeyPrompt({ id: vars.id, message: e.message });
      } else {
        onError(e);
      }
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/backups/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError,
  });
  // Bulut klasöründen / başka bilgisayardan gelen .db.enc dosyası.
  const fileInput = useRef<HTMLInputElement>(null);
  const importFile = useMutation({
    mutationFn: (file: File) => apiUpload<Backup>('/backups/import', file),
    onSuccess: (b) => {
      refresh();
      if (
        window.confirm(
          'Yedek dosyası yüklendi. Şimdi geri yüklensin mi? Uygulanması için yeniden başlatma gerekir.',
        )
      )
        restore.mutate({ id: b.id });
    },
    onError,
  });

  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-bold text-slate-800">Yedekler</h2>
        <div className="flex gap-2">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={importFile.isPending}
            className="rounded-lg bg-slate-200 px-3 py-1 text-sm font-medium text-slate-700 disabled:opacity-40"
          >
            {importFile.isPending ? 'Yükleniyor…' : 'Dosyadan Geri Yükle'}
          </button>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className="rounded-lg bg-slate-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
          >
            {create.isPending ? 'Alınıyor…' : 'Yedek Al'}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".enc"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) importFile.mutate(file);
          }}
        />
      </div>
      {canSettings && (
        <div className="mb-3 space-y-2 rounded-lg bg-slate-50 p-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-slate-600">Bulut klasörü</span>
            <input
              value={cloudDraft ?? cloudDirSaved}
              onChange={(e) => setCloudDraft(e.target.value)}
              placeholder={'örn. C:\\Users\\ali\\OneDrive\\Yedek (boş = kapalı)'}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1"
            />
            <button
              onClick={() =>
                saveSetting.mutate({ key: 'backup.cloudDir', value: (cloudDraft ?? '').trim() })
              }
              disabled={saveSetting.isPending || cloudDraft === null}
              className="rounded-lg bg-slate-700 px-2 py-1 font-medium text-white disabled:opacity-40"
            >
              Kaydet
            </button>
          </div>
          <label className="flex items-center gap-2 text-slate-600">
            <input
              type="checkbox"
              checked={autoDaily}
              onChange={(e) =>
                saveSetting.mutate({ key: 'backup.autoDaily', value: e.target.checked })
              }
            />
            Günlük otomatik yedek (06:00)
          </label>
          <p className="text-xs text-slate-400">
            Şifreli yedek dosyası bu klasöre de kopyalanır; OneDrive/Google Drive gibi bir senkron
            klasörü seçerseniz buluta yüklemeyi sağlayıcının uygulaması yapar. Yedekler asla
            otomatik silinmez.
          </p>
          {cloudDirSaved && (
            <p className="text-xs font-medium text-amber-700">
              Bulut kopyası başka bir bilgisayarda yalnızca kurtarma anahtarıyla açılabilir.
              Anahtarı aşağıdan görüntüleyip güvenli bir yerde saklayın.
            </p>
          )}
        </div>
      )}
      <RecoveryKeySection onError={onError} />
      {keyPrompt && (
        <div className="mb-3 space-y-2 rounded-lg bg-amber-50 p-2 text-sm">
          <p className="text-amber-800">{keyPrompt.message}</p>
          <input
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
            placeholder="xxxx-xxxx-xxxx-…"
            autoCapitalize="none"
            spellCheck={false}
            className="w-full rounded-lg border border-amber-300 bg-white px-2 py-1 font-mono"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setKeyPrompt(null);
                setRecoveryKey('');
              }}
              className="rounded-lg bg-slate-200 px-2 py-1 font-medium"
            >
              Vazgeç
            </button>
            <button
              onClick={() => restore.mutate({ id: keyPrompt.id, recoveryKey: recoveryKey.trim() })}
              disabled={recoveryKey.trim().length < 16 || restore.isPending}
              className="rounded-lg bg-amber-500 px-2 py-1 font-medium text-white disabled:opacity-40"
            >
              Anahtarla Geri Yükle
            </button>
          </div>
        </div>
      )}
      {backups.isLoading && <p className="text-sm text-slate-400">Yükleniyor…</p>}
      {backups.data?.length === 0 && <p className="text-sm text-slate-400">Henüz yedek yok.</p>}
      <ul className="divide-y">
        {(backups.data ?? []).map((b) => (
          <li key={b.id} className="flex items-center gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1 text-slate-600">
              {formatDateTime(b.createdAt)}
              <span className="text-slate-400">
                {' '}
                · {BACKUP_TYPE_LABELS[b.type] ?? b.type} · {formatBytes(b.sizeBytes)}
              </span>
            </span>
            <button
              onClick={() => {
                if (
                  window.confirm(
                    'Bu yedek geri yüklensin mi? Uygulanması için yeniden başlatma gerekir.',
                  )
                )
                  restore.mutate({ id: b.id });
              }}
              disabled={restore.isPending}
              className="rounded-lg bg-amber-500 px-2 py-1 font-medium text-white disabled:opacity-40"
            >
              Geri Yükle
            </button>
            <button
              onClick={() => {
                if (window.confirm('Bu yedek silinsin mi?')) remove.mutate(b.id);
              }}
              disabled={remove.isPending}
              className="rounded-lg bg-red-600 px-2 py-1 font-medium text-white disabled:opacity-40"
            >
              Sil
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Kurtarma anahtarı: yedekleri başka bilgisayarda açmak için. Yönetici şifresiyle görünür.
function RecoveryKeySection({ onError }: { onError: (e: unknown) => void }) {
  const [password, setPassword] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () =>
      api<{ recoveryKey: string }>('/backups/recovery-key', {
        method: 'POST',
        body: { password },
      }),
    onSuccess: (r) => {
      setKey(r.recoveryKey);
      setPassword('');
    },
    onError,
  });
  const keyFile = (k: string) =>
    [
      'Adisyon POS — Yedek Kurtarma Anahtarı',
      `Tarih: ${new Date().toLocaleString('tr-TR')}`,
      '',
      k,
      '',
      'Bu anahtar, yedeklerinizi başka bir bilgisayarda geri yüklemek için gereklidir.',
      'Güvenli bir yerde saklayın; yedeklerle aynı bulut klasörüne KOYMAYIN.',
      '',
    ].join('\r\n');

  return (
    <div className="mb-3 space-y-2 rounded-lg bg-slate-50 p-2 text-sm">
      <p className="font-medium text-slate-700">Kurtarma anahtarı</p>
      <p className="text-xs text-slate-500">
        Yedekler bu anahtarla şifrelenir. Bilgisayar arızalanırsa yedeği yeni bilgisayarda açmak
        için gerekir. Yazdırın ya da indirip bulut klasöründen ayrı, güvenli bir yerde saklayın.
      </p>
      {key ? (
        <>
          <p className="rounded-lg bg-white px-2 py-1 font-mono break-all text-slate-800">{key}</p>
          <div className="flex gap-2">
            <button
              onClick={() => void navigator.clipboard?.writeText(key)}
              className="rounded-lg bg-slate-700 px-2 py-1 font-medium text-white"
            >
              Kopyala
            </button>
            <button
              onClick={() => downloadText('adisyon-kurtarma-anahtari.txt', keyFile(key))}
              className="rounded-lg bg-slate-700 px-2 py-1 font-medium text-white"
            >
              İndir (.txt)
            </button>
            <button
              onClick={() => setKey(null)}
              className="rounded-lg bg-slate-200 px-2 py-1 font-medium"
            >
              Gizle
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reveal.mutate();
          }}
          className="flex gap-2"
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Yönetici şifresi"
            autoComplete="current-password"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1"
          />
          <button
            type="submit"
            disabled={!password || reveal.isPending}
            className="rounded-lg bg-slate-700 px-2 py-1 font-medium text-white disabled:opacity-40"
          >
            Anahtarı Göster
          </button>
        </form>
      )}
    </div>
  );
}

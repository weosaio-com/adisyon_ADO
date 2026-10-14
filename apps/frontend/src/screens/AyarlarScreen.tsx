import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, hasPerm } from '../lib/api';
import QRCode from 'qrcode';
import { InstallButton } from '../lib/install';
import BackupCard from './BackupCard';
import BusinessInfoCard from './BusinessInfoCard';
import CloudBackupCard from './CloudBackupCard';
import CloudMenuCard from './CloudMenuCard';
import LicenseCard from './LicenseCard';
import StorageCard from './StorageCard';
import UpdateCard from './UpdateCard';
import PrinterSettingsCard from './PrinterSettingsCard';

export default function AyarlarScreen() {
  const nav = useNavigate();
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const fail = (e: unknown) => {
    setInfo('');
    setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');
  };

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center gap-3 bg-white px-6 py-3 shadow">
        <button onClick={() => nav('/')} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
          ← Masalar
        </button>
        <h1 className="text-lg font-bold text-slate-800">Ayarlar</h1>
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 overflow-auto p-4">
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-600">{error}</p>}
        {info && <p className="rounded-lg bg-green-50 p-2 text-sm text-green-700">{info}</p>}

        <ServerInfoCard />
        {hasPerm('settings.manage') && (
          <BusinessInfoCard
            onError={fail}
            onInfo={(m) => {
              setError('');
              setInfo(m);
            }}
          />
        )}
        {hasPerm('settings.manage') && (
          <CloudMenuCard
            onError={fail}
            onInfo={(m) => {
              setError('');
              setInfo(m);
            }}
          />
        )}
        {hasPerm('printer.manage') && (
          <PrinterSettingsCard
            onError={fail}
            onInfo={(m) => {
              setError('');
              setInfo(m);
            }}
          />
        )}
        <LicenseCard onError={fail} />
        {hasPerm('update.manage') && (
          <UpdateCard
            onError={fail}
            onInfo={(m) => {
              setError('');
              setInfo(m);
            }}
          />
        )}
        {hasPerm('user.manage') && <RecoveryCard onError={fail} />}
        {hasPerm('backup.manage') && (
          <BackupCard
            onError={fail}
            onInfo={(m) => {
              setError('');
              setInfo(m);
            }}
          />
        )}
        {hasPerm('backup.manage') && (
          <CloudBackupCard
            onError={fail}
            onInfo={(m) => {
              setError('');
              setInfo(m);
            }}
          />
        )}
        {hasPerm('backup.manage') && (
          <StorageCard
            onError={fail}
            onInfo={(m) => {
              setError('');
              setInfo(m);
            }}
          />
        )}
      </div>
    </div>
  );
}

interface ServerInfo {
  port: number;
  addresses: string[];
  urls: string[];
  httpsUrls?: string[];
  caUrls?: string[];
}

// Garsonun tablette gireceği sunucu adresi. IP değişirse buradan görülür.
function ServerInfoCard() {
  const info = useQuery({
    queryKey: ['server-info'],
    queryFn: () => api<ServerInfo>('/devices/server-info'),
  });
  const urls = info.data?.urls ?? [];
  const httpsUrls = info.data?.httpsUrls ?? [];
  const caUrls = info.data?.caUrls ?? [];
  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <h2 className="mb-1 font-bold text-slate-800">Sunucu Adresi (tablet ve telefon)</h2>
      <p className="mb-2 text-sm text-slate-500">
        {httpsUrls.length > 0
          ? 'Tablet ve telefonlarda HTTPS adresini kullanın: bağlantı koptuğunda da uygulama açılır. Her cihaza bir kez güvenlik sertifikasını kurun (kullanım kılavuzu, 6. bölüm).'
          : 'Tablet ya da telefonun tarayıcısında aşağıdaki adresi açın. Ağ/IP değişirse buradan güncel adresi görebilirsiniz.'}
      </p>
      {info.isLoading && <p className="text-sm text-slate-400">Yükleniyor…</p>}
      {!info.isLoading && urls.length === 0 && (
        <p className="text-sm text-slate-400">Ağ adresi bulunamadı.</p>
      )}
      <QrSetup appUrl={httpsUrls[0] ?? urls[0]} caUrl={caUrls[0]} />
      <InstallButton
        label="Bu cihaza uygulama olarak yükle"
        className="mt-3 rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-800"
      />
      <UrlGroup title="HTTPS (önerilen)" urls={httpsUrls} />
      <UrlGroup title="Sertifika indirme adresi (tablette bir kez açın)" urls={caUrls} />
      <UrlGroup
        title={httpsUrls.length > 0 ? 'HTTP (sertifikasız; çevrimdışı açılmaz)' : ''}
        urls={urls}
      />
      <details className="mt-3 rounded-xl bg-slate-50 p-3 text-sm" data-testid="no-wifi-help">
        <summary className="cursor-pointer font-semibold text-slate-700">
          İşletmede WiFi yoksa
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
          <li>
            İnternet gerekmez; bu bilgisayarla tablet ve telefonların aynı ağda olması yeterli.
          </li>
          <li>
            Önerilen: internet bağlantısı olmayan basit bir modem/router. Bu bilgisayarı kabloyla,
            tablet ve telefonları WiFi ile bağlayın.
          </li>
          <li>
            Geçici çözüm: bir Android telefonun erişim noktasını (hotspot) açıp bu bilgisayarı ve
            diğer cihazları ona bağlayın; mobil veri kapalı olabilir. İlk kurulumda deneyin.
          </li>
          <li>Hiç ağ yoksa bu bilgisayar tek başına çalışır; siparişler buradan alınır.</li>
        </ul>
      </details>
    </div>
  );
}

// Tablet/telefon kameraya okutup kurulumu tamamlasin: once sertifika (bir kez), sonra adisyon.
function QrSetup({ appUrl, caUrl }: { appUrl: string | undefined; caUrl: string | undefined }) {
  const [images, setImages] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const targets = [appUrl, caUrl].filter((url): url is string => Boolean(url));
    void Promise.all(
      targets.map(async (url) => {
        const svg = await QRCode.toString(url, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
        });
        return [url, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setImages(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [appUrl, caUrl]);
  if (!appUrl) return null;
  const tiles = [
    ...(caUrl ? [{ url: caUrl, caption: '1. Sertifika (her cihaza bir kez)' }] : []),
    { url: appUrl, caption: caUrl ? '2. Adisyonu aç' : 'Adisyonu aç' },
  ];
  return (
    <div className="mt-3">
      <div className="grid max-w-md grid-cols-2 gap-3" data-testid="server-qr">
        {tiles.map((tile) => (
          <figure key={tile.url} className="rounded-xl bg-slate-50 p-2 text-center">
            {images[tile.url] ? (
              <img
                src={images[tile.url]}
                alt={tile.caption}
                className="mx-auto aspect-square w-full"
              />
            ) : (
              <div className="aspect-square w-full animate-pulse rounded bg-slate-100" />
            )}
            <figcaption className="mt-1 text-xs font-semibold text-slate-600">
              {tile.caption}
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Tablet ya da telefonun kamerasıyla okutun; açılan sayfada “Uygulamayı yükle”ye dokunun.
      </p>
    </div>
  );
}

function UrlGroup({ title, urls }: { title: string; urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {title && <p className="text-xs font-medium text-slate-500">{title}</p>}
      {urls.map((u) => (
        <div
          key={u}
          className="flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-slate-800"
        >
          <span className="min-w-0 break-all">{u}</span>
          <button
            onClick={() => void navigator.clipboard?.writeText(u)}
            className="shrink-0 rounded bg-slate-700 px-2 py-0.5 text-xs font-medium text-white"
          >
            Kopyala
          </button>
        </div>
      ))}
    </div>
  );
}

// --- Guvenlik: sifre kurtarma kodu -------------------------------------------
// Cevrimdisi kasa: e-posta yok. Sahibi kodu uretir, KAGIDA YAZAR. Kod bir daha
// gosterilemez (yalnizca ozeti saklanir) -> ekranda "not al" uyarisi sart.
function RecoveryCard({ onError }: { onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const q = useQuery({
    queryKey: ['recovery'],
    queryFn: () => api<{ enabled: boolean; hasCode: boolean }>('/auth/recovery'),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/auth/recovery/enabled', { method: 'POST', body: { enabled } }),
    onSuccess: () => {
      setCode('');
      qc.invalidateQueries({ queryKey: ['recovery'] });
    },
    onError,
  });
  const generate = useMutation({
    mutationFn: () => api<{ code: string }>('/auth/recovery/generate', { method: 'POST' }),
    onSuccess: (r) => {
      setCode(r.code);
      qc.invalidateQueries({ queryKey: ['recovery'] });
    },
    onError,
  });

  const s = q.data;
  if (!s) return null;

  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <h2 className="mb-1 font-bold text-slate-800">Şifre Kurtarma</h2>
      <p className="mb-3 text-sm text-slate-500">
        Şifrenizi unutursanız giriş ekranında kurtarma kodu ile sıfırlayabilirsiniz.
      </p>

      <label className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => toggle.mutate(e.target.checked)}
          disabled={toggle.isPending}
          className="size-5"
        />
        Şifre kurtarmayı aç
      </label>

      {s.enabled && (
        <>
          <button
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="w-full rounded-lg bg-slate-700 py-2 font-semibold text-white disabled:opacity-40"
          >
            {s.hasCode ? 'Yeni Kod Üret (eskisi geçersiz olur)' : 'Kurtarma Kodu Üret'}
          </button>
          {code && (
            <div className="mt-3 rounded-lg bg-amber-50 p-3">
              <p className="mb-1 text-xs font-semibold text-amber-800">
                Bu kod bir daha gösterilmez — kağıda yazıp saklayın.
              </p>
              <p className="text-center font-mono text-lg font-bold tracking-widest text-slate-800">
                {code}
              </p>
            </div>
          )}
          {!code && s.hasCode && (
            <p className="mt-2 text-xs text-slate-400">
              Kayıtlı bir kurtarma kodu var. Kaybettiyseniz yenisini üretin.
            </p>
          )}
        </>
      )}
    </div>
  );
}

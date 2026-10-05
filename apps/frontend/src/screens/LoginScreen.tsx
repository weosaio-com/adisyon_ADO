import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, apiUpload, login, loginPin, ApiError } from '../lib/api';
import { pullSnapshot } from '../offline/engine';
import { InstallButton, useInstallPrompt } from '../lib/install';

type Mode = 'owner' | 'waiter';

export default function LoginScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const setup = useQuery({
    queryKey: ['auth', 'setup-status'],
    queryFn: () => api<{ required: boolean }>('/auth/setup-status'),
  });
  const [mode, setMode] = useState<Mode>('owner');
  const [username, setUsername] = useState('owner');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const recoveryEnabled = useQuery({
    queryKey: ['auth', 'recovery-status'],
    queryFn: () => api<{ enabled: boolean }>('/auth/recovery/status'),
    retry: false,
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'owner') await login(username, secret);
      else await loginPin(username, secret);
      void pullSnapshot();
      nav('/', { replace: true });
    } catch (value) {
      setError(value instanceof ApiError ? value.message : 'Giriş başarısız.');
    } finally {
      setBusy(false);
    }
  }

  if (setup.data?.required) {
    return (
      <SetupForm onDone={() => qc.invalidateQueries({ queryKey: ['auth', 'setup-status'] })} />
    );
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="flex h-full flex-col justify-center p-6 sm:p-10 lg:p-12">
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand-700 uppercase">
          Güvenli erişim
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-ink-900">
          Tekrar hoş geldiniz
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-500">
          Vardiyanıza devam etmek için hesabınızla giriş yapın.
        </p>
        {!window.isSecureContext && (
          <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-5 font-medium text-amber-800">
            Bu bağlantı güvenli değil (HTTP): bağlantı koptuğunda uygulama yeniden açılamaz.
            Çevrimdışı çalışma için yöneticinizden HTTPS adresini isteyin (Ayarlar › Sunucu Adresi).
          </p>
        )}

        <div className="mt-8 grid grid-cols-2 rounded-2xl bg-stone-100 p-1.5">
          {(['owner', 'waiter'] as Mode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setMode(item);
                setUsername(item === 'owner' ? 'owner' : 'garson');
                setSecret('');
                setError('');
              }}
              className={`min-h-11 rounded-xl text-sm font-bold transition ${
                mode === item ? 'bg-white text-ink-900 shadow-sm' : 'text-stone-500'
              }`}
            >
              {item === 'owner' ? 'Yönetici' : 'Garson'}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-4">
          <Field label="Kullanıcı">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className={INPUT}
              autoCapitalize="none"
              autoComplete="username"
            />
          </Field>
          <Field label={mode === 'owner' ? 'Şifre' : 'PIN'}>
            <input
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              type="password"
              inputMode={mode === 'waiter' ? 'numeric' : 'text'}
              className={INPUT}
              autoComplete="current-password"
            />
          </Field>
        </div>

        {error && (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !secret}
          className="mt-6 min-h-13 w-full rounded-2xl bg-ink-900 px-4 text-base font-black text-white transition hover:bg-ink-800 active:scale-[0.99] disabled:opacity-40"
        >
          {busy ? 'Giriş yapılıyor…' : 'Sisteme giriş yap'}
        </button>
        <InstallHint />
        {mode === 'owner' && recoveryEnabled.data?.enabled && (
          <button
            type="button"
            onClick={() => setRecovery(true)}
            className="mt-4 w-full text-sm font-semibold text-stone-500 hover:text-ink-900"
          >
            Şifremi unuttum
          </button>
        )}
      </form>
      {recovery && <RecoveryModal username={username} onClose={() => setRecovery(false)} />}
    </AuthShell>
  );
}

const INPUT =
  'h-12 w-full rounded-xl border border-stone-200 bg-white px-3 text-base font-medium text-ink-900 shadow-sm placeholder:text-stone-400';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-bold tracking-wide text-stone-600 uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-[#eef0ea] p-3 sm:p-6">
      <div className="grid min-h-[640px] w-full max-w-5xl overflow-hidden rounded-[32px] border border-white/70 bg-white shadow-[0_30px_90px_rgba(21,32,29,0.12)] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden overflow-hidden bg-ink-900 p-12 text-white lg:flex lg:flex-col">
          <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-brand-500/20 blur-3xl" />
          <div className="relative flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500 text-lg font-black">
              AO
            </span>
            <div>
              <p className="font-black tracking-tight">Adisyon</p>
              <p className="text-xs text-stone-400">İşletme operasyon sistemi</p>
            </div>
          </div>
          <div className="relative my-auto max-w-md">
            <p className="text-[11px] font-bold tracking-[0.2em] text-brand-500 uppercase">
              Hızlı · Güvenli · Çevrimdışı
            </p>
            <h2 className="mt-4 text-4xl font-black leading-[1.08] tracking-tight">
              Servisin ritmini bozmayan yönetim.
            </h2>
            <p className="mt-5 max-w-sm text-sm leading-6 text-stone-400">
              Masadan kasaya kadar tüm akış, ekibinizin daha az dokunuşla daha hızlı çalışması için
              tasarlandı.
            </p>
          </div>
          <div className="relative grid grid-cols-3 gap-2">
            {['Canlı masa planı', 'Offline çalışma', 'Anlık raporlar'].map((item) => (
              <div key={item} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <span className="mb-3 block h-1.5 w-6 rounded-full bg-brand-500" />
                <span className="text-xs font-bold leading-4 text-stone-200">{item}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="min-w-0">{children}</section>
      </div>
    </div>
  );
}

function RecoveryModal({ username, onClose }: { username: string; onClose: () => void }) {
  const [user, setUser] = useState(username);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const valid =
    user.trim() !== '' && code.trim().length >= 16 && password.length >= 6 && password === repeat;
  const reset = useMutation({
    mutationFn: () =>
      api('/auth/recovery/reset', {
        method: 'POST',
        body: { username: user.trim(), code: code.trim(), newPassword: password },
      }),
    onSuccess: () => setDone(true),
    onError: (value) =>
      setError(value instanceof ApiError ? value.message : 'Sıfırlama başarısız.'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/65 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl sm:p-8">
        <h2 className="text-xl font-black text-ink-900">Şifre kurtarma</h2>
        {done ? (
          <>
            <p className="mt-3 rounded-xl bg-brand-50 p-3 text-sm text-brand-700">
              Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.
            </p>
            <button
              onClick={onClose}
              className="mt-5 min-h-12 w-full rounded-xl bg-ink-900 font-bold text-white"
            >
              Tamam
            </button>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-6 text-stone-500">
              Ayarlar bölümünden aldığınız tek kullanımlık kurtarma kodunu girin.
            </p>
            <div className="mt-5 space-y-3">
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                className={INPUT}
                autoCapitalize="none"
                placeholder="Kullanıcı"
              />
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={`${INPUT} font-mono tracking-wider`}
                autoCapitalize="characters"
                placeholder="XXXX-XXXX-XXXX-XXXX"
              />
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                className={INPUT}
                placeholder="Yeni şifre"
              />
              <input
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                type="password"
                className={INPUT}
                placeholder="Yeni şifre tekrar"
              />
            </div>
            {repeat !== '' && password !== repeat && (
              <p className="mt-3 text-sm text-red-600">Şifreler eşleşmiyor.</p>
            )}
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                onClick={onClose}
                className="min-h-12 rounded-xl bg-stone-100 font-bold text-stone-600"
              >
                Vazgeç
              </button>
              <button
                onClick={() => {
                  setError('');
                  reset.mutate();
                }}
                disabled={!valid || reset.isPending}
                className="min-h-12 rounded-xl bg-ink-900 font-bold text-white disabled:opacity-40"
              >
                {reset.isPending ? 'Sıfırlanıyor…' : 'Şifreyi sıfırla'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restoreMode, setRestoreMode] = useState(false);
  const valid =
    username.trim().length >= 3 &&
    password.length >= 6 &&
    password === repeat &&
    (pin === '' || pin.length >= 3);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/setup', {
        method: 'POST',
        body: {
          ownerUsername: username.trim(),
          ownerPassword: password,
          ...(pin ? { waiterPin: pin } : {}),
        },
      });
      onDone();
    } catch (value) {
      setError(value instanceof ApiError ? value.message : 'Kurulum başarısız.');
    } finally {
      setBusy(false);
    }
  }

  if (restoreMode) return <SetupRestoreForm onBack={() => setRestoreMode(false)} />;

  return (
    <AuthShell>
      <form onSubmit={submit} className="flex h-full flex-col justify-center p-6 sm:p-10 lg:p-12">
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand-700 uppercase">
          İlk kurulum
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-ink-900">
          İşletmenizi hazırlayın
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-500">
          Yönetici hesabınızı oluşturun. Garson PIN’i isteğe bağlıdır.
        </p>
        <div className="mt-7 space-y-4">
          <Field label="Yönetici kullanıcı">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={INPUT}
              autoCapitalize="none"
            />
          </Field>
          <Field label="Şifre · en az 6 karakter">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              className={INPUT}
            />
          </Field>
          <Field label="Şifre tekrar">
            <input
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              type="password"
              className={INPUT}
            />
          </Field>
          <Field label="Garson PIN · isteğe bağlı">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              type="password"
              inputMode="numeric"
              className={INPUT}
            />
          </Field>
        </div>
        {repeat !== '' && password !== repeat && (
          <p className="mt-3 text-sm text-red-600">Şifreler eşleşmiyor.</p>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !valid}
          className="mt-6 min-h-13 rounded-2xl bg-ink-900 font-black text-white disabled:opacity-40"
        >
          {busy ? 'Kuruluyor…' : 'Kurulumu tamamla'}
        </button>
        <button
          type="button"
          onClick={() => setRestoreMode(true)}
          className="mt-4 w-full text-sm font-semibold text-stone-500 hover:text-ink-900"
        >
          Başka bilgisayardan mı taşıyorsunuz? Yedekten geri yükleyin
        </button>
      </form>
    </AuthShell>
  );
}

// Yeni bilgisayar: eski kurulumun yedeği (bulut klasöründeki .db.enc) + kurtarma
// anahtarı ile tüm veriler (kullanıcılar dahil) geri gelir. Yalnız ana bilgisayarda.
function SetupRestoreForm({ onBack }: { onBack: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [imported, setImported] = useState<{ file: File; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      // Aynı dosya tekrar denenirse (ör. yanlış anahtar) yeniden yüklenmez.
      let id = imported?.file === file ? imported.id : '';
      if (!id) {
        id = (await apiUpload<{ id: string }>('/backups/setup/import', file)).id;
        setImported({ file, id });
      }
      await api(`/backups/setup/${id}/restore`, {
        method: 'POST',
        body: recoveryKey.trim() ? { recoveryKey: recoveryKey.trim() } : {},
      });
      setDone(true);
    } catch (value) {
      setError(value instanceof ApiError ? value.message : 'Geri yükleme başarısız.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="flex h-full flex-col justify-center p-6 sm:p-10 lg:p-12">
        <p className="text-[11px] font-bold tracking-[0.18em] text-brand-700 uppercase">
          Yedekten geri yükle
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-ink-900">
          Verilerinizi taşıyın
        </h1>
        {done ? (
          <>
            <p className="mt-4 rounded-xl bg-brand-50 p-3 text-sm leading-6 text-brand-700">
              Yedek hazırlandı. Uygulamayı kapatıp yeniden açın; ardından eski kullanıcı adı ve
              şifrenizle giriş yapın.
            </p>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-6 text-stone-500">
              Eski bilgisayardaki yedek dosyasını (bulut klasöründeki <code>.db.enc</code>) ve
              Ayarlar &gt; Yedekler bölümünden sakladığınız kurtarma anahtarını seçin.
            </p>
            <div className="mt-7 space-y-4">
              <Field label="Yedek dosyası">
                <input
                  type="file"
                  accept=".enc"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-stone-600"
                />
              </Field>
              <Field label="Kurtarma anahtarı">
                <input
                  value={recoveryKey}
                  onChange={(e) => setRecoveryKey(e.target.value)}
                  placeholder="xxxx-xxxx-xxxx-…"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={`${INPUT} font-mono`}
                />
              </Field>
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={busy || !file}
              className="mt-6 min-h-13 rounded-2xl bg-ink-900 font-black text-white disabled:opacity-40"
            >
              {busy ? 'Geri yükleniyor…' : 'Yedeği geri yükle'}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onBack}
          className="mt-4 w-full text-sm font-semibold text-stone-500 hover:text-ink-900"
        >
          ← Yeni kuruluma dön
        </button>
      </form>
    </AuthShell>
  );
}

// Tablet ve telefonda adisyon uygulama gibi yuklenir (ana ekranda simge, baglanti koptugunda da acilir).
function InstallHint() {
  const { available } = useInstallPrompt();
  if (!available) return null;
  return (
    <div className="mt-4 rounded-2xl bg-stone-50 p-3 text-center text-xs text-stone-500">
      <p className="mb-2">Bu cihaza uygulama olarak yükleyin: ana ekrandan tek dokunuşla açılır.</p>
      <InstallButton className="min-h-11 w-full rounded-xl bg-white font-bold text-ink-900 shadow-sm ring-1 ring-stone-200" />
    </div>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useOnline } from '../lib/connectivity';
import { AccountTab } from './AccountTab';
import { BusinessTab } from './BusinessTab';
import { forgetAllPendingImages, loadPendingImages } from './images';
import { InstallButton, useInstallPrompt } from './install';
import { MenuDraftProvider, useMenuDraft } from './menu-draft';
import { MenuTab } from './MenuTab';
import { persistPanelQueries, restorePanelQueries } from './persist';
import { PosTab } from './PosTab';
import { setupPanelApp } from './pwa';
import { meQuery } from './queries';
import { clearAll, kvGet, kvSet, listDrafts } from './store';
import { saveBarState } from './sync-core';
import { TablesTab } from './TablesTab';
import type { Me } from './types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, errorText, Field, INPUT, Notice } from './ui';

const LOADING = <p className="p-8 text-center text-sm text-stone-500">Yükleniyor…</p>;

// Isletme paneli: POS'suz isletme menusunu buradan yonetir; POS'lu isletme durumu ve QR'lari gorur.
// Telefona/bilgisayara uygulama olarak yuklenir; son veriler cihazda saklanir, internetsiz de acilir.
export default function PanelApp() {
  const qc = useQueryClient();
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    document.title = 'İşletme paneli';
    setupPanelApp();
    let cancelled = false;
    let stop: (() => void) | undefined;
    // Cihazdaki son menu/masa verisi once yuklenir: internet yokken panel bununla acilir.
    void Promise.all([restorePanelQueries(qc), loadPendingImages()]).finally(() => {
      if (cancelled) return;
      stop = persistPanelQueries(qc);
      setRestored(true);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [qc]);
  return restored ? <PanelRoot /> : LOADING;
}

function PanelRoot() {
  const me = useQuery(meQuery);
  const online = useOnline();
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  // Arka plandaki yenileme hatasi (ag kesintisi) paneli ve kaydedilmemis taslagi silmesin.
  if (me.data) return <Shell me={me.data} />;
  if (me.isPending && online) return LOADING;
  return (
    <div className="mx-auto max-w-sm p-8 text-center">
      <Notice tone={online ? 'error' : 'warn'}>
        {online
          ? errorText(me.error)
          : 'İnternet yok. Paneli bu cihazda ilk kez açmak için internet gerekir; sonrasında internetsiz de açılır.'}
      </Notice>
      <button onClick={() => void me.refetch()} className={`${BUTTON_PRIMARY} mt-4`}>
        Tekrar dene
      </button>
    </div>
  );
}

function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api('/api/panel/login', { json: { email: email.trim(), password } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: meQuery.queryKey }),
  });
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
        className="w-full max-w-sm space-y-3 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-stone-200/70"
      >
        <h1 className="text-xl font-black text-ink-900">İşletme paneli</h1>
        <p className="text-sm text-stone-500">QR menünüzü ve masalarınızı buradan yönetin.</p>
        <Field label="E-posta">
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={INPUT}
            required
          />
        </Field>
        <Field label="Parola">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={INPUT}
            required
          />
        </Field>
        {login.isError && <Notice tone="error">{errorText(login.error)}</Notice>}
        <button
          type="submit"
          disabled={login.isPending || !email || !password}
          className={`${BUTTON_PRIMARY} w-full py-2.5`}
        >
          Giriş yap
        </button>
        <InstallHint />
      </form>
    </div>
  );
}

// Ilk giristen once de gorunsun: panel telefona ve bilgisayara uygulama olarak yuklenebilir.
function InstallHint() {
  const { available } = useInstallPrompt();
  if (!available) return null;
  return (
    <div className="border-t border-stone-100 pt-3 text-center text-xs text-stone-500">
      <p className="mb-2">Paneli telefonunuza ya da bilgisayarınıza uygulama olarak yükleyin.</p>
      <InstallButton className={`${BUTTON_SECONDARY} w-full`} />
    </div>
  );
}

const TABS = [
  { to: 'menu', label: 'Menü' },
  { to: 'tables', label: 'Masalar' },
  { to: 'business', label: 'İşletme' },
  { to: 'pos', label: 'Adisyon programı' },
  { to: 'account', label: 'Hesap' },
];

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const [branchId, setBranchId] = useState(me.branches[0]?.id ?? '');
  const [leaving, setLeaving] = useState(false);
  const branch = me.branches.find((item) => item.id === branchId) ?? me.branches[0];

  // Cihazda baska bir hesabin verisi kaldiysa (oturumu dusmus, cikis yapilmamis) silinir.
  useEffect(() => {
    void (async () => {
      const owner = await kvGet<string>('owner');
      if (owner && owner !== me.user.email) {
        await clearAll();
        forgetAllPendingImages();
        qc.removeQueries({
          predicate: (query) => query.queryKey[0] === 'panel' && query.queryKey[1] !== 'me',
        });
      }
      await kvSet('owner', me.user.email);
    })();
  }, [me.user.email, qc]);

  // Cikis: oturum kapanir ve bu cihazdaki panel verisi silinir (internet gerekir: oturum cerezi
  // yalniz bulutta kapatilabilir). Sayfa bastan yuklenir, bellekte veri kalmaz.
  const logout = async () => {
    const drafts = await listDrafts();
    if (
      drafts.length > 0 &&
      !window.confirm('Bu cihazda yayınlanmamış değişiklikler var; çıkınca silinecek. Çıkılsın mı?')
    ) {
      return;
    }
    setLeaving(true);
    try {
      await api('/api/panel/logout', { method: 'POST' });
    } catch {
      // Oturum zaten dusmus olabilir; cihaz verisi yine silinir.
    }
    await clearAll();
    if ('caches' in window) await caches.delete('panel-images').catch(() => false);
    window.location.assign('/panel');
  };

  return (
    <div className="min-h-screen pb-36">
      <header className="bg-ink-900 text-white print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-black" data-testid="panel-tenant">
              {me.tenant.name}
            </p>
            <p className="truncate text-xs text-white/70">
              {me.tenant.planLabel} · {me.user.email}
            </p>
          </div>
          {me.branches.length > 1 && (
            <select
              value={branch?.id}
              onChange={(event) => setBranchId(event.target.value)}
              className="rounded-lg bg-white/10 px-2 py-1 text-sm"
              aria-label="Şube"
            >
              {me.branches.map((item) => (
                <option key={item.id} value={item.id} className="text-ink-900">
                  {item.name}
                </option>
              ))}
            </select>
          )}
          <InstallButton
            label="Yükle"
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-semibold"
          />
          <button
            onClick={() => void logout()}
            disabled={!online || leaving}
            title={online ? undefined : 'Çıkış için internet gerekir'}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
            data-testid="logout"
          >
            Çıkış
          </button>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2 [scrollbar-width:none]">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={`/panel/${tab.to}`}
              className={({ isActive }) =>
                `shrink-0 rounded-t-xl px-4 py-2.5 text-sm font-bold whitespace-nowrap ${
                  isActive ? 'bg-[#f5f5f2] text-ink-900' : 'text-white/75'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {!online && (
        <div className="bg-amber-100 text-amber-950 print:hidden" data-testid="offline-banner">
          <p className="mx-auto max-w-5xl px-4 py-2 text-sm font-semibold">
            İnternet yok — değişiklikler bu cihazda saklanıyor.
          </p>
        </div>
      )}

      {me.tenant.status === 'suspended' && (
        <div className="mx-auto max-w-5xl px-4 pt-4">
          <Notice tone="error">
            Hesabınız askıya alındı; müşteriler menüyü göremiyor. Lütfen bizimle iletişime geçin.
          </Notice>
        </div>
      )}
      {me.tenant.status === 'active' && !me.tenant.features['qr.menu'] && (
        <div className="mx-auto max-w-5xl px-4 pt-4">
          <Notice tone="warn">Paketiniz QR menüyü içermiyor; müşteri sayfası açılmaz.</Notice>
        </div>
      )}

      {branch ? (
        <MenuDraftProvider key={branch.id} branch={branch}>
          <main className="mx-auto max-w-5xl px-4 pt-4">
            <Routes>
              <Route path="menu" element={<MenuTab />} />
              <Route path="tables" element={<TablesTab branch={branch} />} />
              <Route path="business" element={<BusinessTab />} />
              <Route path="pos" element={<PosTab branch={branch} />} />
              <Route path="account" element={<AccountTab />} />
              <Route path="*" element={<Navigate to="/panel/menu" replace />} />
            </Routes>
          </main>
          <SaveBar />
        </MenuDraftProvider>
      ) : (
        <main className="mx-auto max-w-5xl px-4 pt-4">
          <Notice tone="warn">Hesabınıza bağlı şube yok.</Notice>
        </main>
      )}
    </div>
  );
}

// Menu ya da isletme bilgisi degisince altta kalir: kaydet ya da vazgec. Internet yokken kayit
// cihazda bekler ve internet gelince kendiliginden yayinlanir.
function SaveBar() {
  const draft = useMenuDraft();
  const state = saveBarState({
    dirty: draft.dirty,
    online: draft.online,
    busy: draft.saving,
    publishPending: draft.publishPending,
    conflict: draft.conflict,
    error: draft.error !== '',
  });
  if (state.kind === 'hidden') return null;

  const discard = (label: string) => (
    <button
      onClick={draft.discard}
      disabled={draft.saving}
      className={`${BUTTON_SECONDARY} flex-1 sm:flex-none`}
    >
      {label}
    </button>
  );
  const save = (label: string) => (
    <button
      onClick={draft.save}
      disabled={draft.saving}
      className={`${BUTTON_PRIMARY} flex-1 sm:flex-none`}
      data-testid="save-menu"
    >
      {label}
    </button>
  );

  let message: ReactNode;
  let actions: ReactNode = null;
  switch (state.kind) {
    case 'conflict':
      message = <span className="text-red-700">{draft.error}</span>;
      actions = discard('Güncel menüyü yükle');
      break;
    case 'publishing':
      message = <span className="text-stone-600">Yayınlanıyor…</span>;
      break;
    case 'queued':
      message = (
        <span className="text-amber-900">
          {state.online
            ? 'Yayınlanıyor…'
            : 'Kaydedildi; internet gelince kendiliğinden yayınlanacak.'}
        </span>
      );
      actions = discard('Vazgeç');
      break;
    case 'error':
      message = <span className="text-red-700">{draft.error}</span>;
      actions = state.dirty ? (
        <>
          {discard('Vazgeç')}
          {save('Tekrar dene')}
        </>
      ) : (
        discard('Tamam')
      );
      break;
    case 'dirty':
      message = (
        <span className="text-stone-600">
          {state.online
            ? 'Kaydedilmemiş değişiklikler var.'
            : 'İnternet yok. Kaydederseniz bu cihazda saklanır, internet gelince yayınlanır.'}
        </span>
      );
      actions = (
        <>
          {discard('Vazgeç')}
          {save(state.online ? 'Kaydet ve yayınla' : 'Kaydet')}
        </>
      );
      break;
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white/95 backdrop-blur print:hidden">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p className="w-full text-sm sm:w-auto sm:min-w-0 sm:flex-1" data-testid="save-status">
          {message}
        </p>
        {actions}
      </div>
    </div>
  );
}

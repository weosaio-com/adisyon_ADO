import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { AccountTab } from './AccountTab';
import { BusinessTab } from './BusinessTab';
import { MenuDraftProvider, useMenuDraft } from './menu-draft';
import { MenuTab } from './MenuTab';
import { PosTab } from './PosTab';
import { meQuery } from './queries';
import { TablesTab } from './TablesTab';
import type { Me } from './types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, errorText, Field, INPUT, Notice } from './ui';

// Isletme paneli: POS'suz isletme menusunu buradan yonetir; POS'lu isletme durumu ve QR'lari gorur.
export default function PanelApp() {
  const me = useQuery(meQuery);
  useEffect(() => {
    document.title = 'İşletme paneli';
  }, []);
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  // Arka plandaki yenileme hatasi (ag kesintisi) paneli ve kaydedilmemis taslagi silmesin.
  if (me.data) return <Shell me={me.data} />;
  if (me.isPending) {
    return <p className="p-8 text-center text-sm text-stone-500">Yükleniyor…</p>;
  }
  return (
    <div className="p-8 text-center">
      <Notice tone="error">{errorText(me.error)}</Notice>
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
      </form>
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
  const [branchId, setBranchId] = useState(me.branches[0]?.id ?? '');
  const branch = me.branches.find((item) => item.id === branchId) ?? me.branches[0];
  const logout = useMutation({
    mutationFn: () => api('/api/panel/logout', { method: 'POST' }),
    // Sayfayi bastan yukle: bellekte menu/masa verisi kalmasin, giris ekrani gelsin.
    onSettled: () => window.location.assign('/panel'),
  });

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
          <button
            onClick={() => logout.mutate()}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-semibold"
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

// Menu ya da isletme bilgisi degisince altta kalir: kaydet ya da vazgec.
function SaveBar() {
  const draft = useMenuDraft();
  if (!draft.dirty && !draft.error) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white/95 backdrop-blur print:hidden">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p className="w-full text-sm sm:w-auto sm:min-w-0 sm:flex-1" data-testid="save-status">
          {draft.error ? (
            <span className="text-red-700">{draft.error}</span>
          ) : (
            <span className="text-stone-600">Kaydedilmemiş değişiklikler var.</span>
          )}
        </p>
        <button
          onClick={draft.discard}
          disabled={draft.saving}
          className={`${BUTTON_SECONDARY} flex-1 sm:flex-none`}
        >
          {draft.conflict ? 'Güncel menüyü yükle' : draft.dirty ? 'Vazgeç' : 'Tekrar dene'}
        </button>
        {!draft.conflict && draft.dirty && (
          <button
            onClick={draft.save}
            disabled={draft.saving}
            className={`${BUTTON_PRIMARY} flex-1 sm:flex-none`}
            data-testid="save-menu"
          >
            {draft.saving ? 'Kaydediliyor…' : 'Kaydet ve yayınla'}
          </button>
        )}
      </div>
    </div>
  );
}

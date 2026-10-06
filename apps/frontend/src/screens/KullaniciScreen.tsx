import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, getUser } from '../lib/api';
import TextPromptModal from '../components/TextPromptModal';

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
}

const ROLE_LABELS: Record<string, string> = { owner: 'Yönetici', waiter: 'Garson' };

export default function KullaniciScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const meId = getUser()?.id;
  const [error, setError] = useState('');
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');
  const refresh = () => {
    setError('');
    qc.invalidateQueries({ queryKey: ['users'] });
  };

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/users/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: fail,
  });

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center gap-3 bg-white px-6 py-3 shadow">
        <button onClick={() => nav('/')} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
          ← Masalar
        </button>
        <h1 className="text-lg font-bold text-slate-800">Kullanıcılar</h1>
      </header>

      <div className="mx-auto w-full max-w-md flex-1 space-y-4 overflow-auto p-4">
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-600">{error}</p>}

        <div className="rounded-2xl bg-white p-4 shadow">
          <h2 className="mb-2 font-bold text-slate-800">Kayıtlı Kullanıcılar</h2>
          {users.isLoading && <p className="text-sm text-slate-400">Yükleniyor…</p>}
          <ul className="divide-y">
            {(users.data ?? []).map((u) => (
              <li key={u.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span
                    className={
                      'font-medium ' +
                      (u.isActive ? 'text-slate-700' : 'text-slate-400 line-through')
                    }
                  >
                    {u.displayName}
                  </span>
                  <span className="text-slate-400">
                    {' '}
                    · {u.username} · {ROLE_LABELS[u.role] ?? u.role}
                  </span>
                </span>
                <button
                  onClick={() => setResetFor(u)}
                  disabled={update.isPending}
                  className="rounded-lg bg-slate-200 px-2 py-1 font-medium disabled:opacity-40"
                >
                  {u.role === 'owner' ? 'Şifre' : 'PIN'}
                </button>
                {u.id !== meId && (
                  <>
                    <button
                      onClick={() => update.mutate({ id: u.id, body: { isActive: !u.isActive } })}
                      disabled={update.isPending}
                      className="rounded-lg bg-amber-500 px-2 py-1 font-medium text-white disabled:opacity-40"
                    >
                      {u.isActive ? 'Pasif' : 'Aktif'}
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`${u.displayName} silinsin mi?`)) remove.mutate(u.id);
                      }}
                      disabled={remove.isPending}
                      className="rounded-lg bg-red-600 px-2 py-1 font-medium text-white disabled:opacity-40"
                    >
                      Sil
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>

        <CreateCard onDone={refresh} onError={fail} />
      </div>

      {/* Yönetici şifreyle, garson PIN ile girer; sıfırlama da aynı alana yazar.
          window.prompt kullanılmaz: kasa uygulamasında (Electron) desteklenmez. */}
      {resetFor && (
        <TextPromptModal
          title={resetFor.role === 'owner' ? 'Şifreyi değiştir' : 'PIN değiştir'}
          description={resetFor.displayName}
          label={
            resetFor.role === 'owner' ? 'Yeni şifre (en az 6 karakter)' : 'Yeni PIN (en az 3 hane)'
          }
          secret
          numeric={resetFor.role !== 'owner'}
          minLength={resetFor.role === 'owner' ? 6 : 3}
          maxLength={64}
          busy={update.isPending}
          onConfirm={(value) => {
            const isOwner = resetFor.role === 'owner';
            update.mutate(
              { id: resetFor.id, body: isOwner ? { password: value } : { pin: value } },
              { onSuccess: () => setResetFor(null) },
            );
          }}
          onClose={() => setResetFor(null)}
        />
      )}
    </div>
  );
}

function CreateCard({ onDone, onError }: { onDone: () => void; onError: (e: unknown) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'owner' | 'waiter'>('waiter');
  const [secret, setSecret] = useState(''); // owner: şifre, waiter: PIN

  const create = useMutation({
    mutationFn: () =>
      api('/users', {
        method: 'POST',
        body: {
          username: username.trim(),
          displayName: displayName.trim(),
          role,
          ...(role === 'owner' ? { password: secret } : { pin: secret }),
        },
      }),
    onSuccess: () => {
      setUsername('');
      setDisplayName('');
      setSecret('');
      onDone();
    },
    onError,
  });

  const valid =
    username.trim().length >= 3 &&
    displayName.trim().length >= 1 &&
    secret.length >= (role === 'owner' ? 6 : 3);

  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <h2 className="mb-2 font-bold text-slate-800">Yeni Kullanıcı</h2>
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Kullanıcı adı"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Görünen ad"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'owner' | 'waiter')}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="waiter">Garson</option>
            <option value="owner">Yönetici</option>
          </select>
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            type="password"
            placeholder={role === 'owner' ? 'Şifre (en az 6)' : 'PIN (en az 3)'}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
          />
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !valid}
            className="rounded-lg bg-slate-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
          >
            Ekle
          </button>
        </div>
      </div>
    </div>
  );
}

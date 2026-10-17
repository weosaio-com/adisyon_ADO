import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, hasPerm, LICENSE_LOCKED_EVENT } from '../lib/api';
import { useLicenseStatus } from './LicenseBanner';
import { lockDialogContent } from './license-notice';

// Lisans penceresi: bir istek 403 LICENSE_LOCKED dondugunde (lib/api.ts genel `license-locked`
// olayini yayar) ya da seritteki dugmeyle acilir. Lisans anahtari girisi (yetkisi olana) ve
// destek iletisimi. Engelleyici degildir: kapatip acik adisyonlari kapatmaya devam edilebilir.
export default function LicenseLockDialog() {
  const qc = useQueryClient();
  const status = useLicenseStatus();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    const onLocked = () => {
      setOpen(true);
      setError('');
      setActivated(false);
      void qc.invalidateQueries({ queryKey: ['license'] });
    };
    window.addEventListener(LICENSE_LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(LICENSE_LOCKED_EVENT, onLocked);
  }, [qc]);

  const activate = useMutation({
    mutationFn: () =>
      api('/license/activate', { method: 'POST', body: { licenseKey: key.trim() } }),
    onSuccess: () => {
      setKey('');
      setError('');
      setActivated(true);
      void qc.invalidateQueries({ queryKey: ['license'] });
      // QR menu karti lisanstaki ozellige bakar; yeni lisans hemen yansisin.
      void qc.invalidateQueries({ queryKey: ['cloud', 'status'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Lisans etkinleştirilemedi.'),
  });

  if (!open) return null;
  const s = status.data;
  const content = lockDialogContent(s);
  const canEnterKey = hasPerm('license.manage') && s?.verifiable !== false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="license-dialog-title"
      data-testid="license-dialog"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-xl">
        <h2 id="license-dialog-title" className="text-lg font-black text-ink-900">
          {activated ? 'Lisans etkinleştirildi' : content.title}
        </h2>
        <p className="mt-2 text-sm text-stone-600">
          {activated ? 'Lisansınız kaydedildi; yeni adisyon açabilirsiniz.' : content.message}
        </p>
        {s?.supportContact && (
          <p className="mt-3 rounded-xl bg-stone-100 px-3 py-2 text-sm text-stone-700">
            Destek: <span className="font-semibold">{s.supportContact}</span>
          </p>
        )}

        {!activated && canEnterKey && (
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim().length >= 20 && !activate.isPending) activate.mutate();
            }}
          >
            <label className="block text-sm font-semibold text-stone-600">
              Lisans anahtarı
              <textarea
                autoFocus
                value={key}
                onChange={(event) => setKey(event.target.value)}
                rows={3}
                placeholder="ADO1...."
                className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 font-mono text-xs font-normal text-ink-900"
              />
            </label>
            {error && <p className="mt-2 text-sm font-medium text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={key.trim().length < 20 || activate.isPending}
              className="mt-2 min-h-12 w-full rounded-2xl bg-ink-900 text-sm font-black text-white disabled:opacity-40"
            >
              {activate.isPending ? 'Doğrulanıyor…' : 'Etkinleştir'}
            </button>
          </form>
        )}
        {!activated && !canEnterKey && (
          <p className="mt-3 text-sm text-stone-500">
            {s?.verifiable === false
              ? 'Bu kurulumda lisans doğrulama anahtarı tanımlı değil; satıcınıza başvurun.'
              : 'Lisans anahtarını yalnızca yönetici girebilir; yöneticinize haber verin.'}
          </p>
        )}

        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-3 min-h-12 w-full rounded-2xl border border-stone-200 text-sm font-bold text-stone-600"
        >
          {activated ? 'Tamam' : 'Kapat'}
        </button>
      </div>
    </div>
  );
}

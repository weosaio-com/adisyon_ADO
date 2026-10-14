import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, hasPerm } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useLicenseStatus } from '../components/LicenseBanner';
import {
  phaseDetails,
  policySummary,
  statusBadge,
  type BadgeTone,
} from '../components/license-notice';
import CloudLinkStatus from './CloudLinkStatus';

// --- Lisans -----------------------------------------------------------------
// Yillik lisans durumu + anahtar girisi. Politika (LICENSING.md §8): bitisten 14 gun once uyari,
// sonra ek sure, ardindan yalniz YENI adisyon durur. `enforced=false` iken lisans HICBIR SEYI
// ENGELLEMEZ; kart bunu acikca yazar ki kullanici panige kapilmasin.
const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  info: 'bg-sky-100 text-sky-700',
  ok: 'bg-green-100 text-green-700',
  warning: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700',
};

export default function LicenseCard({ onError }: { onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const q = useLicenseStatus();

  const activate = useMutation({
    mutationFn: () =>
      api('/license/activate', { method: 'POST', body: { licenseKey: key.trim() } }),
    onSuccess: () => {
      setKey('');
      qc.invalidateQueries({ queryKey: ['license'] });
      // QR menu karti lisanstaki ozellige bakar; yeni lisans hemen yansisin.
      qc.invalidateQueries({ queryKey: ['cloud', 'status'] });
    },
    onError,
  });

  const s = q.data;
  if (!s) return null;
  const badge = statusBadge(s);
  const qrMenu = s.features['qr.menu'] === true;
  const details = phaseDetails(s);

  return (
    <div className="rounded-2xl bg-white p-4 shadow">
      <h2 className="mb-2 font-bold text-slate-800">Lisans</h2>
      <div className="mb-2 flex items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[badge.tone]}`}>
          {badge.label}
        </span>
        {!s.enforced && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            Zorunlu değil
          </span>
        )}
      </div>

      {s.customerName && <p className="text-sm text-slate-600">{s.customerName}</p>}
      {s.licenseId && (
        <p className="text-xs text-slate-400" data-testid="license-id">
          Lisans no: {s.licenseId}
        </p>
      )}
      {s.state !== 'none' && (
        <p className="text-sm text-slate-600" data-testid="license-qr-menu">
          QR menü: {qrMenu ? 'dahil' : 'dahil değil'}
        </p>
      )}
      <CloudLinkStatus onError={onError} />
      {s.validUntil && (
        <p className="text-sm text-slate-600">
          Bitiş: {formatDateTime(s.validUntil)}
          {s.daysLeft !== null && (
            <span
              className={s.daysLeft <= 14 ? ' font-semibold text-amber-600' : ' text-slate-400'}
            >
              {' '}
              ({s.daysLeft >= 0 ? `${s.daysLeft} gün kaldı` : `${-s.daysLeft} gün geçti`})
            </span>
          )}
        </p>
      )}
      {details.map((line) => (
        <p
          key={line}
          className={`text-sm ${s.locked ? 'font-semibold text-red-600' : 'text-slate-600'}`}
        >
          {line}
        </p>
      ))}
      <p className="mt-2 text-xs text-slate-400">{policySummary(s)}</p>
      {s.supportContact && (
        <p className="mt-1 text-xs text-slate-500">Destek: {s.supportContact}</p>
      )}

      {!s.verifiable && (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
          Bu kurulumda doğrulama anahtarı tanımlı değil; anahtar girilemez.
        </p>
      )}
      {s.verifiable && s.needsReentry && (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
          Kayıtlı lisans bu kurulumda doğrulanamadı. Lisans anahtarınızı yeniden girin.
        </p>
      )}

      {hasPerm('license.manage') && s.verifiable && (
        <div className="mt-3">
          <label className="mb-1 block text-sm font-medium text-slate-600">Lisans anahtarı</label>
          <textarea
            value={key}
            onChange={(e) => setKey(e.target.value)}
            rows={3}
            placeholder="ADO1...."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
          />
          <button
            onClick={() => activate.mutate()}
            disabled={key.trim().length < 20 || activate.isPending}
            className="mt-2 w-full rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
          >
            {activate.isPending ? 'Doğrulanıyor…' : 'Lisansı Etkinleştir'}
          </button>
        </div>
      )}
    </div>
  );
}

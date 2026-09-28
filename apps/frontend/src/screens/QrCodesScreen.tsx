import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, ApiError } from '../lib/api';
import type { CloudStatus, Hall, Table } from '../lib/types';

/** Masadaki QR'in actigi adres (bulut + masa kodu). */
export function tableMenuUrl(cloudUrl: string, code: string): string {
  return `${cloudUrl}/m/${code}`;
}

// Yazdirilacak masa QR kartlari (A4'te 3 sutun). Kod okutulunca musterinin telefonunda o
// masanin menusu acilir. Kod yenilenirse eski QR calismaz, yenisi basilmali.
export default function QrCodesScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const status = useQuery({
    queryKey: ['cloud', 'status'],
    queryFn: () => api<CloudStatus>('/cloud/status'),
  });
  const tables = useQuery({
    queryKey: ['tables', 'qr'],
    queryFn: () => api<Table[]>('/tables?active=true'),
  });
  const halls = useQuery({ queryKey: ['halls'], queryFn: () => api<Hall[]>('/halls') });
  const business = useQuery({
    queryKey: ['settings', 'business'],
    queryFn: () => api<{ name: string }>('/settings/business'),
  });
  const [images, setImages] = useState<Record<string, string>>({});

  const cloudUrl = status.data?.connected ? status.data.url : null;
  const hallOrder = useMemo(
    () => new Map((halls.data ?? []).map((hall, index) => [hall.id, { hall, index }])),
    [halls.data],
  );
  const rows = useMemo(
    () =>
      (tables.data ?? [])
        .filter((table) => table.publicCode)
        .sort(
          (a, b) =>
            (hallOrder.get(a.hallId)?.index ?? 0) - (hallOrder.get(b.hallId)?.index ?? 0) ||
            a.name.localeCompare(b.name, 'tr', { numeric: true }),
        ),
    [tables.data, hallOrder],
  );

  useEffect(() => {
    if (!cloudUrl) return;
    let cancelled = false;
    void Promise.all(
      rows.map(async (table) => {
        const svg = await QRCode.toString(tableMenuUrl(cloudUrl, table.publicCode as string), {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
        });
        return [table.id, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setImages(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [cloudUrl, rows]);

  const rotate = useMutation({
    mutationFn: (id: string) => api<Table>(`/tables/${id}/public-code`, { method: 'POST' }),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['tables'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Kod yenilenemedi.'),
  });

  return (
    <div className="flex min-h-full flex-col bg-slate-100 print:bg-white">
      <header className="flex items-center gap-3 bg-white px-6 py-3 shadow print:hidden">
        <button
          onClick={() => nav('/tables-admin')}
          className="rounded-lg bg-slate-200 px-3 py-1 font-medium"
        >
          ← Masalar
        </button>
        <h1 className="text-lg font-bold text-slate-800">Masa QR Kodları</h1>
        {cloudUrl && rows.length > 0 && (
          <button
            onClick={() => window.print()}
            className="ml-auto rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white"
          >
            Yazdır
          </button>
        )}
      </header>

      {!status.isLoading && !cloudUrl ? (
        <div className="m-6 rounded-2xl bg-white p-6 text-center shadow">
          <p className="font-semibold text-slate-800">QR menü bulutuna bağlı değil.</p>
          <p className="mt-1 text-sm text-slate-500">
            Önce Ayarlar › QR Menü (Bulut) kartından eşleştirme kodu ile bağlanın.
          </p>
          <button
            onClick={() => nav('/settings')}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            Ayarlara git
          </button>
        </div>
      ) : (
        <>
          <p className="px-6 pt-4 text-sm text-slate-500 print:hidden">
            Kartları yazdırıp masalara yapıştırın. Bir masanın kodunu yenilerseniz eski QR çalışmaz;
            o masanın kartını yeniden basın.
          </p>
          {error && (
            <p className="mx-6 mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700 print:hidden">
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-3 print:gap-4 print:p-0">
            {rows.map((table) => (
              <div
                key={table.id}
                data-testid={`qr-card-${table.id}`}
                className="flex break-inside-avoid flex-col items-center rounded-2xl border border-slate-200 bg-white p-4 text-center print:rounded-none print:border-dashed print:border-slate-400"
              >
                <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  {business.data?.name}
                </p>
                {images[table.id] ? (
                  <img
                    src={images[table.id]}
                    alt={`${table.name} QR kodu`}
                    data-testid="qr-image"
                    className="my-2 aspect-square w-full max-w-44"
                  />
                ) : (
                  <div className="my-2 aspect-square w-full max-w-44 animate-pulse rounded bg-slate-100" />
                )}
                <p className="text-lg font-black text-slate-900">{table.name}</p>
                <p className="text-xs text-slate-500">{hallOrder.get(table.hallId)?.hall.name}</p>
                <p className="mt-1 text-[11px] text-slate-600">Menü için telefonunuzla okutun</p>
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        `${table.name} için yeni kod oluşturulsun mu? Eski QR çalışmaz.`,
                      )
                    ) {
                      rotate.mutate(table.id);
                    }
                  }}
                  disabled={rotate.isPending}
                  className="mt-2 text-xs text-red-600 hover:text-red-800 disabled:opacity-40 print:hidden"
                >
                  Kodu yenile
                </button>
              </div>
            ))}
            {rows.length === 0 && !tables.isLoading && (
              <p className="col-span-full p-6 text-center text-slate-400">Aktif masa yok.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

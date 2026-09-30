import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { MENU_LIMITS } from '@ado/shared/menu-core';
import { api } from '../lib/api';
import { nextTableName, tableMenuUrl } from '../lib/tables';
import { meQuery, tablesQuery } from './queries';
import type { BranchSummary, PanelTable } from './types';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  Dialog,
  errorText,
  Field,
  INPUT,
  Notice,
} from './ui';

const NO_TABLES: PanelTable[] = [];

// Masalar ve yazdirilacak QR kartlari (A4'te 3 sutun, POS'taki kart duzeni). Kod yenilenirse
// eski QR calismaz; o masanin karti yeniden basilmali.
export function TablesTab({ branch }: { branch: BranchSummary }) {
  const qc = useQueryClient();
  const options = tablesQuery(branch.id);
  const tables = useQuery(options);
  const readOnly = branch.source === 'pos';
  const [name, setName] = useState<string | null>(null);
  const [hall, setHall] = useState('');
  const [editing, setEditing] = useState<PanelTable | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const rows = tables.data ?? NO_TABLES;
  const suggestion = nextTableName(rows.map((table) => table.name));
  const base = `/api/panel/branches/${branch.id}/tables`;

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      rows.map(async (table) => {
        const svg = await QRCode.toString(tableMenuUrl(window.location.origin, table.code), {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
        });
        return [table.code, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`];
      }),
    ).then((entries) => {
      if (!cancelled) setImages(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [rows]);

  const refresh = () => {
    setError('');
    void qc.invalidateQueries({ queryKey: options.queryKey });
    void qc.invalidateQueries({ queryKey: meQuery.queryKey });
  };
  const onError = (err: unknown) => setError(errorText(err));

  const add = useMutation({
    mutationFn: () =>
      api<PanelTable>(base, { json: { name: (name ?? suggestion).trim(), hall: hall.trim() } }),
    onSuccess: (created) => {
      // Oneri hemen siradaki ada gecsin (liste yenilenmeden once).
      qc.setQueryData(options.queryKey, (old) => [...(old ?? []), created]);
      setName(null);
      refresh();
    },
    onError,
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string; hall: string }) =>
      api<PanelTable>(`${base}/${input.id}`, {
        method: 'PATCH',
        json: { name: input.name, hall: input.hall },
      }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError,
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api<PanelTable>(`${base}/${id}/rotate`, { method: 'POST' }),
    onSuccess: refresh,
    onError,
  });
  const newName = name ?? suggestion;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <p className="min-w-0 flex-1 text-sm text-stone-500">
          {readOnly
            ? 'Masalar adisyon programından geliyor; programdaki Düzen ekranından değiştirin. QR kartlarını buradan da yazdırabilirsiniz.'
            : 'Kartları yazdırıp masalara yapıştırın. Bir masanın kodunu yenilerseniz eski QR çalışmaz; o masanın kartını yeniden basın.'}
        </p>
        {rows.length > 0 && (
          <button onClick={() => window.print()} className={BUTTON_PRIMARY}>
            Yazdır
          </button>
        )}
      </div>

      {!readOnly && (
        <div className="print:hidden">
          <Card>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (newName.trim()) add.mutate();
              }}
              className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
            >
              <Field label="Masa adı">
                <input
                  value={newName}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={MENU_LIMITS.tableName}
                  className={INPUT}
                  data-testid="table-name"
                />
              </Field>
              <Field label="Bölüm (isteğe bağlı)">
                <input
                  value={hall}
                  onChange={(event) => setHall(event.target.value)}
                  maxLength={MENU_LIMITS.hallName}
                  placeholder="Bahçe"
                  className={INPUT}
                />
              </Field>
              <button
                type="submit"
                disabled={add.isPending || !newName.trim()}
                className={`${BUTTON_PRIMARY} col-span-2 py-2.5 sm:col-span-1`}
                data-testid="table-add"
              >
                + Masa ekle
              </button>
            </form>
          </Card>
        </div>
      )}

      {error && (
        <div className="print:hidden">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {tables.isError && (
        <div className="print:hidden">
          <Notice tone="error">{errorText(tables.error)}</Notice>
        </div>
      )}
      {tables.isSuccess && rows.length === 0 && (
        <p className="p-6 text-center text-sm text-stone-400">
          {readOnly ? 'Programda masa yok.' : 'Henüz masa yok. Yukarıdan ekleyin.'}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-3 print:gap-4">
        {rows.map((table) => (
          <div
            key={table.id}
            data-testid={`qr-card-${table.name}`}
            className="flex break-inside-avoid flex-col items-center rounded-2xl bg-white p-4 text-center shadow-sm ring-1 ring-stone-200/70 print:rounded-none print:shadow-none print:ring-0 print:outline-1 print:outline-stone-400 print:outline-dashed"
          >
            <p className="w-full truncate text-xs font-semibold tracking-wide text-stone-500 uppercase">
              {branch.name}
            </p>
            {images[table.code] ? (
              <img
                src={images[table.code]}
                alt={`${table.name} QR kodu`}
                data-testid="qr-image"
                className="my-2 aspect-square w-full max-w-44"
              />
            ) : (
              <div className="my-2 aspect-square w-full max-w-44 animate-pulse rounded bg-stone-100" />
            )}
            <p className="text-lg font-black text-ink-900">{table.name}</p>
            <p className="min-h-4 text-xs text-stone-500">{table.hall}</p>
            <p className="mt-1 text-[11px] text-stone-600">Menü için telefonunuzla okutun</p>
            <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs print:hidden">
              <a
                href={`/m/${table.code}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-brand-700"
              >
                Önizle
              </a>
              {!readOnly && (
                <>
                  <button onClick={() => setEditing(table)} className="font-semibold text-ink-800">
                    Düzenle
                  </button>
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
                    className="text-red-600 disabled:opacity-40"
                  >
                    Kodu yenile
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <TableDialog
          table={editing}
          busy={rename.isPending || remove.isPending}
          onClose={() => setEditing(null)}
          onSave={(input) => rename.mutate({ id: editing.id, ...input })}
          onDelete={() => {
            if (window.confirm(`${editing.name} silinsin mi? Masadaki QR artık çalışmaz.`)) {
              remove.mutate(editing.id);
            }
          }}
        />
      )}
    </div>
  );
}

function TableDialog({
  table,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  table: PanelTable;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { name: string; hall: string }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(table.name);
  const [hall, setHall] = useState(table.hall);
  return (
    <Dialog title="Masa düzenle" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave({ name: name.trim(), hall: hall.trim() });
        }}
        className="space-y-3"
      >
        <Field label="Masa adı">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MENU_LIMITS.tableName}
            className={INPUT}
            autoFocus
          />
        </Field>
        <Field label="Bölüm (isteğe bağlı)">
          <input
            value={hall}
            onChange={(event) => setHall(event.target.value)}
            maxLength={MENU_LIMITS.hallName}
            className={INPUT}
          />
        </Field>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="rounded-xl bg-red-50 px-4 py-2 text-sm font-bold text-red-700 disabled:opacity-40"
          >
            Sil
          </button>
          <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
            Vazgeç
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className={`${BUTTON_PRIMARY} flex-1`}
          >
            Kaydet
          </button>
        </div>
      </form>
    </Dialog>
  );
}

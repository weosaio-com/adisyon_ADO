import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { Hall, Table } from '../lib/types';

export default function MasaScreen() {
  const nav = useNavigate();
  const [hall, setHall] = useState<string | null>(null); // null = tümü
  const [hallModal, setHallModal] = useState<Hall | 'new' | null>(null);
  const [tableModal, setTableModal] = useState<Table | 'new' | null>(null);

  const halls = useQuery({ queryKey: ['halls'], queryFn: () => api<Hall[]>('/halls') });
  const tables = useQuery({ queryKey: ['tables'], queryFn: () => api<Table[]>('/tables') });

  const shown = (tables.data ?? []).filter((t) => hall === null || t.hallId === hall);
  const hallName = (id: string) => (halls.data ?? []).find((h) => h.id === id)?.name ?? '';

  return (
    <div className="flex h-full flex-col bg-slate-100 md:flex-row">
      <aside className="flex w-full flex-col bg-white shadow md:w-72">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <button
            onClick={() => nav('/')}
            className="rounded-lg bg-slate-200 px-3 py-1 font-medium"
          >
            ← Masalar
          </button>
          <h1 className="font-bold text-slate-800">Salonlar</h1>
          <button
            onClick={() => setHallModal('new')}
            className="ml-auto rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white"
          >
            + Salon
          </button>
        </header>
        <ul className="flex-1 overflow-auto">
          <li>
            <button
              onClick={() => setHall(null)}
              className={`w-full border-b px-4 py-3 text-left font-medium ${hall === null ? 'bg-blue-50' : ''}`}
            >
              Tümü
            </button>
          </li>
          {(halls.data ?? []).map((h) => (
            <li key={h.id} className="flex items-center border-b">
              <button
                onClick={() => setHall(h.id)}
                className={`flex-1 px-4 py-3 text-left font-medium ${hall === h.id ? 'bg-blue-50' : ''}`}
              >
                {h.name}
                {h.isActive === false && (
                  <span className="ml-2 rounded bg-slate-200 px-1.5 text-xs text-slate-500">
                    pasif
                  </span>
                )}
              </button>
              <button
                onClick={() => setHallModal(h)}
                className="px-3 py-3 text-sm text-slate-400 hover:text-slate-700"
              >
                ✎
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3">
          <h2 className="font-bold text-slate-800">
            {hall === null ? 'Tüm Masalar' : hallName(hall)}
          </h2>
          <button
            onClick={() => setTableModal('new')}
            disabled={(halls.data ?? []).length === 0}
            className="ml-auto rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            + Masa
          </button>
        </header>
        <ul className="flex-1 overflow-auto p-2">
          {shown.length === 0 && <li className="p-6 text-center text-slate-400">Masa yok</li>}
          {shown.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setTableModal(t)}
                className="flex w-full items-center justify-between border-b px-3 py-3 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium text-slate-800">{t.name}</span>
                  {hall === null && (
                    <span className="text-xs text-slate-400">{hallName(t.hallId)}</span>
                  )}
                  {t.isActive === false && (
                    <span className="rounded bg-slate-200 px-1.5 text-xs text-slate-500">
                      pasif
                    </span>
                  )}
                </span>
                {t.seats ? <span className="text-sm text-slate-500">{t.seats} kişi</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </main>

      {hallModal && (
        <HallModal
          hall={hallModal === 'new' ? null : hallModal}
          onClose={() => setHallModal(null)}
        />
      )}
      {tableModal && (
        <TableModal
          table={tableModal === 'new' ? null : tableModal}
          halls={halls.data ?? []}
          defaultHallId={hall}
          onClose={() => setTableModal(null)}
        />
      )}
    </div>
  );
}

function HallModal({ hall, onClose }: { hall: Hall | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(hall?.name ?? '');
  const [isActive, setIsActive] = useState(hall?.isActive ?? true);
  const [error, setError] = useState('');
  const done = () => {
    qc.invalidateQueries({ queryKey: ['halls'] });
    onClose();
  };
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), isActive };
      return hall
        ? api(`/halls/${hall.id}`, { method: 'PATCH', body })
        : api('/halls', { method: 'POST', body });
    },
    onSuccess: done,
    onError: fail,
  });
  const del = useMutation({
    mutationFn: () => api(`/halls/${hall!.id}`, { method: 'DELETE' }),
    onSuccess: done,
    onError: fail,
  });

  return (
    <Modal title={hall ? 'Salon Düzenle' : 'Yeni Salon'} onClose={onClose}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Salon adı"
        className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2"
      />
      <label className="mb-3 flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Aktif
      </label>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <Actions
        onDelete={hall ? () => del.mutate() : undefined}
        onSave={() => save.mutate()}
        saveDisabled={save.isPending || name.trim() === ''}
      />
    </Modal>
  );
}

function TableModal({
  table,
  halls,
  defaultHallId,
  onClose,
}: {
  table: Table | null;
  halls: Hall[];
  defaultHallId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [hallId, setHallId] = useState(table?.hallId ?? defaultHallId ?? halls[0]?.id ?? '');
  const [name, setName] = useState(table?.name ?? '');
  const [seats, setSeats] = useState(table?.seats ? String(table.seats) : '');
  const [isActive, setIsActive] = useState(table?.isActive ?? true);
  const [error, setError] = useState('');
  const done = () => {
    qc.invalidateQueries({ queryKey: ['tables'] });
    onClose();
  };
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'İşlem başarısız.');

  const seatsNum = seats.trim() ? parseInt(seats, 10) : undefined;
  const valid =
    name.trim() !== '' &&
    hallId !== '' &&
    (seatsNum === undefined || (Number.isInteger(seatsNum) && seatsNum > 0));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        hallId,
        name: name.trim(),
        isActive,
        ...(seatsNum !== undefined ? { seats: seatsNum } : {}),
      };
      return table
        ? api(`/tables/${table.id}`, { method: 'PATCH', body })
        : api('/tables', { method: 'POST', body });
    },
    onSuccess: done,
    onError: fail,
  });
  const del = useMutation({
    mutationFn: () => api(`/tables/${table!.id}`, { method: 'DELETE' }),
    onSuccess: done,
    onError: fail,
  });

  return (
    <Modal title={table ? 'Masa Düzenle' : 'Yeni Masa'} onClose={onClose}>
      <label className="mb-1 block text-xs font-medium text-slate-500">Salon</label>
      <select
        value={hallId}
        onChange={(e) => setHallId(e.target.value)}
        className="mb-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
      >
        {halls.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Masa adı"
        className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2"
      />
      <input
        value={seats}
        onChange={(e) => setSeats(e.target.value)}
        inputMode="numeric"
        placeholder="Koltuk sayısı (isteğe bağlı)"
        className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2"
      />
      <label className="mb-3 flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Aktif
      </label>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <Actions
        onDelete={table ? () => del.mutate() : undefined}
        onSave={() => save.mutate()}
        saveDisabled={save.isPending || !valid}
      />
    </Modal>
  );
}

function Actions({
  onDelete,
  onSave,
  saveDisabled,
}: {
  onDelete?: (() => void) | undefined;
  onSave: () => void;
  saveDisabled: boolean;
}) {
  return (
    <div className="flex gap-2">
      {onDelete && (
        <button
          onClick={onDelete}
          className="rounded-lg bg-red-100 px-4 py-2 font-medium text-red-700"
        >
          Sil
        </button>
      )}
      <button
        onClick={onSave}
        disabled={saveDisabled}
        className="flex-1 rounded-lg bg-blue-600 py-2 font-semibold text-white disabled:opacity-40"
      >
        Kaydet
      </button>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          <button onClick={onClose} className="rounded-lg bg-slate-200 px-3 py-1 font-medium">
            Kapat
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

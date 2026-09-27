import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, getUser, hasPerm } from '../lib/api';
import { useLiveEvents } from '../lib/useLiveEvents';
import { formatKurus } from '../lib/format';
import type { Order, PrintJobRow, Table } from '../lib/types';
import SyncBadge from '../offline/SyncBadge';
import { offlineOpenTable } from '../offline/actions';
import { isOffline } from '../offline/engine';
import { draftAll } from '../offline/db';
import { readHalls, readTables, readOpenOrders, readHeldOrders } from '../offline/read';
import type { DraftOrder } from '../offline/sync-core';

export default function TablesScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const user = getUser();
  const halls = useQuery({ queryKey: ['halls'], queryFn: readHalls });
  const tables = useQuery({ queryKey: ['tables', 'active'], queryFn: readTables });
  useLiveEvents();
  const openOrders = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: readOpenOrders,
    refetchInterval: 30_000,
  });
  const heldOrders = useQuery({
    queryKey: ['orders', 'held'],
    queryFn: readHeldOrders,
    refetchInterval: 30_000,
  });
  const localDrafts = useQuery({
    queryKey: ['local-drafts'],
    queryFn: () => draftAll(),
    refetchInterval: 2000,
  });
  const cashStatus = useQuery({
    queryKey: ['cash', 'status'],
    queryFn: () => api<{ open: boolean }>('/cash/status'),
    retry: false,
    refetchInterval: 30_000,
  });
  const cashBlocked = cashStatus.data?.open === false;
  // Kagit bitti / yazici kapali: fis sessizce kaybolmasin, yonetici gorsun.
  const canManagePrinters = hasPerm('printer.manage');
  const failedPrints = useQuery({
    queryKey: ['printers', 'jobs', 'failed'],
    queryFn: () => api<PrintJobRow[]>('/printers/jobs?status=failed'),
    enabled: canManagePrinters,
    retry: false,
    refetchInterval: 30_000,
  });
  const failedPrintCount = failedPrints.data?.length ?? 0;

  const openByTable = new Map<string, Order>();
  for (const order of openOrders.data ?? [])
    if (order.tableId) openByTable.set(order.tableId, order);
  const openTakeaway = (openOrders.data ?? []).filter((order) => !order.tableId);
  const heldByTable = new Map<string, Order>();
  for (const order of heldOrders.data ?? [])
    if (order.tableId) heldByTable.set(order.tableId, order);
  const localByTable = new Map<string, DraftOrder>();
  for (const draft of localDrafts.data ?? [])
    if (draft.tableId && !draft.serverId) localByTable.set(draft.tableId, draft);

  const createOrder = useMutation({
    mutationFn: (tableId: string) => api<Order>('/orders', { method: 'POST', body: { tableId } }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders', 'open'] });
      nav(`/orders/${order.id}`);
    },
    onError: (error) => alert(error instanceof ApiError ? error.message : 'Adisyon açılamadı.'),
  });
  const createTakeaway = useMutation({
    mutationFn: (type: 'takeaway' | 'delivery') =>
      api<Order>('/orders', { method: 'POST', body: { type } }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders', 'open'] });
      nav(`/orders/${order.id}`);
    },
    onError: (error) => alert(error instanceof ApiError ? error.message : 'Adisyon açılamadı.'),
  });
  const cancelOrder = useMutation({
    mutationFn: (orderId: string) =>
      api(`/orders/${orderId}/cancel`, { method: 'POST', body: { reason: 'İptal' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders', 'open'] }),
    onError: (error) => alert(error instanceof ApiError ? error.message : 'İptal edilemedi.'),
  });
  const resumeOrder = useMutation({
    mutationFn: (orderId: string) => api<Order>(`/orders/${orderId}/resume`, { method: 'POST' }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      nav(`/orders/${order.id}`);
    },
    onError: (error) =>
      alert(error instanceof ApiError ? error.message : 'Adisyon yeniden açılamadı.'),
  });

  const canCancel = hasPerm('order.cancel');
  const askCancel = (order: Order) => {
    const type = order.type === 'delivery' ? 'paket' : 'gel-al';
    if (confirm(`Bu ${type} adisyonunu iptal etmek istiyor musunuz?`)) cancelOrder.mutate(order.id);
  };

  async function onTable(table: Table) {
    const open = openByTable.get(table.id);
    const local = localByTable.get(table.id);
    const held = heldByTable.get(table.id);
    if (open) return nav(`/orders/${open.id}`);
    if (local) return nav(`/orders/${local.id}`);
    if (cashBlocked) {
      alert('Yeni adisyon açmak için önce kasa oturumunu açın.');
      return;
    }
    if (held) return resumeOrder.mutate(held.id);
    if (isOffline()) {
      const id = await offlineOpenTable(table.id, table.name);
      qc.invalidateQueries({ queryKey: ['local-drafts'] });
      return nav(`/orders/${id}`);
    }
    createOrder.mutate(table.id);
  }

  const loading = halls.isLoading || tables.isLoading || openOrders.isLoading;
  const busy = createOrder.isPending || resumeOrder.isPending || createTakeaway.isPending;
  const offline = isOffline();
  const activeTableCount = openByTable.size + heldByTable.size + localByTable.size;
  const freeTableCount = Math.max(0, (tables.data?.length ?? 0) - activeTableCount);
  const openTotal = (openOrders.data ?? []).reduce((sum, order) => sum + order.grandTotal, 0);

  return (
    <div className="min-h-full bg-[#f5f5f2]">
      <header className="sticky top-0 z-10 border-b border-stone-200/80 bg-[#f5f5f2]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <p className="text-[11px] font-bold tracking-[0.18em] text-brand-700 uppercase">
              Servis merkezi
            </p>
            <h1 className="mt-0.5 text-2xl font-black tracking-tight text-ink-900">Masa planı</h1>
          </div>
          <div className="flex items-center gap-3">
            <SyncBadge />
            <div className="hidden items-center gap-2 rounded-full border border-stone-200 bg-white py-1.5 pr-3 pl-1.5 shadow-sm sm:flex">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-900 text-xs font-bold text-white">
                {(user?.displayName ?? user?.username ?? 'K')
                  .slice(0, 1)
                  .toLocaleUpperCase('tr-TR')}
              </span>
              <span className="text-sm font-semibold text-ink-800">
                {user?.displayName ?? user?.role ?? ''}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] p-4 sm:p-6">
        {cashBlocked && (
          <div className="mb-5 flex flex-col justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950 sm:flex-row sm:items-center">
            <div>
              <p className="font-black">Kasa oturumu kapalı</p>
              <p className="text-sm text-amber-800">
                Mevcut adisyonları görüntüleyebilirsiniz; yeni sipariş için kasayı açın.
              </p>
            </div>
            {hasPerm('cash.manage') && (
              <button
                onClick={() => nav('/cash')}
                className="min-h-10 rounded-xl bg-amber-900 px-4 text-sm font-bold text-white"
              >
                Kasaya git
              </button>
            )}
          </div>
        )}

        {failedPrintCount > 0 && (
          <div
            data-testid="print-failed-banner"
            className="mb-5 flex flex-col justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-950 sm:flex-row sm:items-center"
          >
            <div>
              <p className="font-black">{failedPrintCount} fiş yazdırılamadı</p>
              <p className="text-sm text-red-800">
                Yazıcının açık olduğunu ve kağıdı kontrol edin, sonra fişi tekrar gönderin.
              </p>
            </div>
            <button
              onClick={() => nav('/settings')}
              className="min-h-10 rounded-xl bg-red-900 px-4 text-sm font-bold text-white"
            >
              Yazıcı ayarları
            </button>
          </div>
        )}

        <section className="mb-6 grid grid-cols-3 gap-2 sm:max-w-xl sm:gap-3">
          <Summary label="Aktif masa" value={activeTableCount} tone="dark" />
          <Summary label="Boş masa" value={freeTableCount} tone="green" />
          <Summary label="Açık tutar" value={formatKurus(openTotal)} />
        </section>

        <section className="mb-8 rounded-3xl border border-stone-200/80 bg-white p-4 shadow-panel sm:p-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-lg font-bold text-ink-900">Paket ve gel-al</h2>
              <p className="mt-0.5 text-sm text-stone-500">
                Masasız siparişleri buradan hızlıca yönetin.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => createTakeaway.mutate('delivery')}
                disabled={busy || offline || cashBlocked}
                className="min-h-11 rounded-xl bg-sky-600 px-4 text-sm font-bold text-white transition hover:bg-sky-700 active:scale-[0.98] disabled:opacity-40"
              >
                + Paket sipariş
              </button>
              <button
                onClick={() => createTakeaway.mutate('takeaway')}
                disabled={busy || offline || cashBlocked}
                className="min-h-11 rounded-xl bg-brand-600 px-4 text-sm font-bold text-white transition hover:bg-brand-700 active:scale-[0.98] disabled:opacity-40"
              >
                + Gel-al sipariş
              </button>
            </div>
          </div>
          {offline && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              Çevrimdışıyken paket ve gel-al siparişi açılamaz.
            </p>
          )}
          {openTakeaway.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {openTakeaway.map((order) => (
                <div key={order.id} className="relative">
                  <button
                    data-testid={`takeaway-${order.id}`}
                    onClick={() => nav(`/orders/${order.id}`)}
                    disabled={busy}
                    className={`flex min-h-28 w-full flex-col items-start justify-between rounded-2xl p-4 text-left text-white transition hover:-translate-y-0.5 active:translate-y-0 ${
                      order.type === 'delivery' ? 'bg-sky-600' : 'bg-brand-600'
                    }`}
                  >
                    <span className="text-xs font-bold tracking-wider text-white/75 uppercase">
                      {order.type === 'delivery' ? 'Paket' : 'Gel-al'} · #
                      {order.orderNo.split('-')[1] ?? order.orderNo}
                    </span>
                    <span className="text-lg font-black">{formatKurus(order.grandTotal)}</span>
                  </button>
                  {/* Iptal yalniz yetkiliye (sunucu da order.cancel ister); bos adisyonu garson icinden kapatir. */}
                  {canCancel && (
                    <button
                      onClick={() => askCancel(order)}
                      disabled={busy || cancelOrder.isPending}
                      title="İptal et"
                      className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/15 text-lg text-white hover:bg-black/25 disabled:opacity-40"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black tracking-tight text-ink-900">Salonlar</h2>
            <p className="text-sm text-stone-500">
              Sipariş açmak veya mevcut adisyona dönmek için masaya dokunun.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs font-semibold text-stone-500">
            <Legend color="bg-brand-500" label="Boş" />
            <Legend color="bg-ink-900" label="Dolu" />
            <Legend color="bg-violet-500" label="Beklemede" />
          </div>
        </div>

        {loading && <p className="rounded-2xl bg-white p-6 text-stone-500">Masalar yükleniyor…</p>}
        {(halls.data ?? []).map((hall) => {
          const hallTables = (tables.data ?? []).filter((table) => table.hallId === hall.id);
          return (
            <section key={hall.id} className="mb-8">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-sm font-extrabold tracking-wide text-ink-800 uppercase">
                  {hall.name}
                </h3>
                <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[11px] font-bold text-stone-600">
                  {hallTables.length} masa
                </span>
              </div>
              {hallTables.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-stone-300 p-5 text-sm text-stone-500">
                  Bu salonda henüz masa yok.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">
                  {hallTables.map((table) => {
                    const open = openByTable.get(table.id);
                    const local = !open ? localByTable.get(table.id) : undefined;
                    const held = !open && !local ? heldByTable.get(table.id) : undefined;
                    const active = open ?? local ?? held;
                    const state = held ? 'held' : local ? 'local' : open ? 'open' : 'free';
                    return (
                      <button
                        key={table.id}
                        data-testid={`table-${table.id}`}
                        onClick={() => void onTable(table)}
                        disabled={busy}
                        className={`group relative flex min-h-32 flex-col items-start justify-between overflow-hidden rounded-2xl border p-4 text-left shadow-sm transition duration-150 hover:-translate-y-0.5 hover:shadow-panel active:translate-y-0 disabled:opacity-50 ${
                          state === 'open'
                            ? 'border-ink-900 bg-ink-900 text-white'
                            : state === 'held'
                              ? 'border-violet-500 bg-violet-500 text-white'
                              : state === 'local'
                                ? 'border-amber-400 bg-amber-400 text-amber-950'
                                : 'border-stone-200 bg-white text-ink-900'
                        }`}
                      >
                        <span
                          className={`absolute top-4 right-4 h-2.5 w-2.5 rounded-full ${
                            state === 'free' ? 'bg-brand-500' : 'bg-white/70'
                          }`}
                        />
                        <div>
                          <span className="block text-xl font-black tracking-tight">
                            {table.name}
                          </span>
                          <span
                            className={`mt-1 block text-[11px] font-bold tracking-wide uppercase ${
                              state === 'free' ? 'text-stone-400' : 'text-white/65'
                            }`}
                          >
                            {state === 'free'
                              ? 'Siparişe hazır'
                              : state === 'held'
                                ? 'Beklemede'
                                : state === 'local'
                                  ? 'Senkron bekliyor'
                                  : 'Aktif adisyon'}
                          </span>
                        </div>
                        {active ? (
                          <span className="text-base font-black">
                            {formatKurus(active.grandTotal)}
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-brand-700">Aç →</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}

function Summary({
  label,
  value,
  tone = 'light',
}: {
  label: string;
  value: string | number;
  tone?: 'light' | 'dark' | 'green';
}) {
  return (
    <div
      className={`rounded-2xl border p-3 sm:p-4 ${
        tone === 'dark'
          ? 'border-ink-900 bg-ink-900 text-white'
          : tone === 'green'
            ? 'border-brand-100 bg-brand-50 text-brand-700'
            : 'border-stone-200 bg-white text-ink-900'
      }`}
    >
      <span className="block truncate text-[10px] font-bold tracking-wide opacity-65 uppercase">
        {label}
      </span>
      <span className="mt-1 block truncate text-lg font-black sm:text-xl">{value}</span>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

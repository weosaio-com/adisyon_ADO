import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, hasPerm, isConnectivityError } from '../lib/api';
import { useLiveEvents } from '../lib/useLiveEvents';
import { formatKurus, formatQty } from '../lib/format';
import type { Hall, Order, OrderItem, Product, Table } from '../lib/types';
import TextPromptModal from '../components/TextPromptModal';
import ReasonModal from './ReasonModal';
import { CANCEL_REASONS, VOID_REASONS } from './reason';
import { MAX_QUANTITY_MILLI } from './payment-input';
import PaymentModal from './PaymentModal';
import DiscountModal from './DiscountModal';
import TableTransferModal from './TableTransferModal';
import SplitModal from './SplitModal';
import SyncBadge, { useSyncState } from '../offline/SyncBadge';
import { OrderProblems } from '../offline/SyncPanel';
import { isOffline } from '../offline/engine';
import { draftDelete } from '../offline/db';
import { ulid } from '../offline/ids';
import {
  isLocalId,
  offlineAddLine,
  offlineAddToServerOrder,
  offlineSubmit,
  offlineSubmitServerOrder,
  offlineUpdateQty,
  offlineRemoveLine,
  readLocalOrder,
} from '../offline/actions';
import {
  readCategories,
  readHalls,
  readProducts,
  readServerOrder,
  readTables,
  type ShownItem,
} from '../offline/read';
import { SHADOW_PREFIX } from '../offline/sync-core';

type PhoneView = 'products' | 'order';
// Sunucu kaleminin arayuzde kullanilan ek alanlari (lib/types OrderItem'da yok). offline:
// cevrimdisi eklenip henuz sunucuya gecmemis kalem (golge taslak, OFF-4).
type ServerItem = OrderItem & ShownItem & { voidReason?: string | null };
const isShadow = (item: OrderItem) => (item as ServerItem).offline === true;

// Yazma istegi yanitsiz kaldi (Wi-Fi koptu): islem sunucuya ulasmis olabilir; adisyon tazelenir.
const UNCERTAIN_ORDER_MESSAGE =
  'Bağlantı koptu; işlem sunucuya ulaşmış olabilir. Adisyonu kontrol edip gerekirse tekrar deneyin.';

export default function OrderScreen() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [activeCat, setActiveCat] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [transfer, setTransfer] = useState<'move' | 'merge' | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [noteItem, setNoteItem] = useState<OrderItem | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState('');
  // Mutfaga gitmis kalemin iptali: onay + gerekce penceresi (URN-3). Tek dokunusla iptal olmaz.
  const [voidFor, setVoidFor] = useState<OrderItem | null>(null);
  const [voidError, setVoidError] = useState('');
  // Telefonda (md alti) urunler ve adisyon ayni ekrana sigmaz: ikisi arasinda gecilir. Cevrimdisi
  // taslak sunucuya gecince yeni adrese yonlendirilir (ekran yeniden kurulur); gorunum korunur.
  const location = useLocation();
  const [phoneView, setPhoneView] = useState<PhoneView>(
    () => (location.state as { phoneView?: PhoneView } | null)?.phoneView ?? 'products',
  );
  const local = isLocalId(id);
  const offline = useSyncState().mode === 'offline';

  useLiveEvents();
  const order = useQuery({
    queryKey: ['order', id],
    // Sunucu adisyonu baglanti yoksa snapshot'tan; cevrimdisi eklenen kalemlerle (OFF-4).
    queryFn: (): Promise<Order & { serverId?: string; fromSnapshot?: boolean }> =>
      local ? readLocalOrder(id) : readServerOrder(id),
    refetchInterval: local ? 2_000 : 30_000,
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: readCategories });
  const products = useQuery({ queryKey: ['products', 'active'], queryFn: readProducts });
  // Masa adi: sunucu adisyonunda `table`, cevrimdisi taslakta masa listesinden.
  const tables = useQuery({ queryKey: ['tables', 'active'], queryFn: readTables });
  const halls = useQuery({ queryKey: ['halls'], queryFn: readHalls });
  const cashStatus = useQuery({
    queryKey: ['cash', 'status'],
    queryFn: () => api<{ open: boolean }>('/cash/status'),
    retry: false,
    refetchInterval: 30_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['order', id] });
  // Her hatada adisyon tazelenir: ORDER_CHANGED (baska cihaz degistirdi) ya da yaniti kaybolan
  // istekte ekran sunucudaki gercek durumu gostersin.
  const fail = (value: unknown) => {
    refresh();
    if (value instanceof ApiError && value.code === 'PRODUCT_INACTIVE') {
      qc.invalidateQueries({ queryKey: ['products'] });
    }
    setError(
      isConnectivityError(value)
        ? UNCERTAIN_ORDER_MESSAGE
        : value instanceof ApiError
          ? value.message
          : 'İşlem başarısız.',
    );
  };
  // Cevrimici kalem ekleme tekrar korumasi (OFF-6): yaniti kaybolan istekten sonra ayni urune
  // tekrar dokunulursa ayni clientOpId gider; sunucu ilk istegi uyguladiysa ikinci kalem acmaz.
  const pendingAdd = useRef<{ productId: string; key: string } | null>(null);

  const addItem = useMutation({
    mutationFn: (product: Product) => {
      if (local)
        return offlineAddLine(id, {
          id: product.id,
          name: product.name,
          salePrice: product.salePrice,
        });
      // Baglanti yok: acik adisyona ekleme kuyruga yazilir (ADD_LINE {orderId}), bekliyor
      // olarak gosterilir; baglanti gelince sunucuya gider. OFF-4
      if (isOffline())
        return offlineAddToServerOrder(
          { id, label: place.title, tableId: currentOrder?.tableId ?? null },
          { id: product.id, name: product.name, salePrice: product.salePrice },
        );
      const prev = pendingAdd.current;
      const key = prev?.productId === product.id ? prev.key : ulid();
      pendingAdd.current = { productId: product.id, key };
      return api(`/orders/${id}/items`, {
        method: 'POST',
        body: { productId: product.id, quantity: 1000, clientOpId: key },
      });
    },
    onSuccess: () => {
      pendingAdd.current = null;
      setError('');
      refresh();
    },
    onError: (value) => {
      // Kesin ret (4xx): anahtar birakilir. Yanitsiz kalan istek: anahtar tekrar icin saklanir.
      if (!isConnectivityError(value)) pendingAdd.current = null;
      fail(value);
    },
  });
  const sendKitchen = useMutation({
    mutationFn: async () => {
      if (local) return offlineSubmit(id);
      const items = currentOrder?.items ?? [];
      const shadowPending = items.some((i) => isShadow(i) && i.status === 'pending');
      // Cevrimdisi eklenenler kuyruga (SUBMIT_ORDER {orderId}); sunucudakiler dogrudan.
      if (isOffline()) return offlineSubmitServerOrder(id);
      if (shadowPending) await offlineSubmitServerOrder(id);
      if (items.some((i) => !isShadow(i) && i.status === 'pending') || !shadowPending) {
        await api(`/orders/${id}/send-kitchen`, { method: 'POST' });
      }
    },
    onSuccess: refresh,
    onError: fail,
  });
  // Taslak ve golge (cevrimdisi eklenen) kalemler yerelde; sunucu kalemleri sunucuda duzenlenir.
  const draftIdFor = (shadow: boolean) => (local ? id : shadow ? SHADOW_PREFIX + id : null);
  const updateQty = useMutation({
    mutationFn: ({
      itemId,
      quantity,
      shadow,
    }: {
      itemId: string;
      quantity: number;
      shadow: boolean;
    }) => {
      const draftId = draftIdFor(shadow);
      return draftId
        ? offlineUpdateQty(draftId, itemId, quantity)
        : api(`/orders/${id}/items/${itemId}`, { method: 'PATCH', body: { quantity } });
    },
    onSuccess: refresh,
    onError: fail,
  });
  const removeItem = useMutation({
    mutationFn: ({ itemId, shadow }: { itemId: string; shadow: boolean }) => {
      const draftId = draftIdFor(shadow);
      return draftId
        ? offlineRemoveLine(draftId, itemId)
        : api(`/orders/${id}/items/${itemId}`, { method: 'DELETE' });
    },
    onSuccess: refresh,
    onError: fail,
  });
  const voidItem = useMutation({
    mutationFn: ({ itemId, reason }: { itemId: string; reason: string }) =>
      api(`/orders/${id}/items/${itemId}/void`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      setVoidFor(null);
      refresh();
    },
    onError: (value) => {
      refresh();
      setVoidError(value instanceof ApiError ? value.message : 'Kalem iptal edilemedi.');
    },
  });
  const hold = useMutation({
    mutationFn: () => api(`/orders/${id}/hold`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      nav('/', { replace: true });
    },
    onError: fail,
  });
  const printBill = useMutation({
    mutationFn: () => api(`/printers/order/${id}/bill`, { method: 'POST' }),
    onError: fail,
  });
  const saveNote = useMutation({
    mutationFn: ({ itemId, note }: { itemId: string; note: string }) =>
      api(`/orders/${id}/items/${itemId}/note`, { method: 'PUT', body: { note } }),
    onSuccess: () => {
      setNoteItem(null);
      refresh();
    },
    onError: fail,
  });
  const leave = () => {
    qc.invalidateQueries({ queryKey: ['orders'] });
    nav('/', { replace: true });
  };
  // Yanlislikla acilan bos adisyon: garson da kapatabilir, masa bosalir.
  const discard = useMutation({
    mutationFn: () => api(`/orders/${id}/discard`, { method: 'POST' }),
    onSuccess: leave,
    onError: fail,
  });
  // Toplami 0 olan adisyon (tam indirim/ikram, sifir fiyatli urun): odeme alinmadan kapatilir.
  const closeOrder = useMutation({
    mutationFn: () => api(`/orders/${id}/close`, { method: 'POST' }),
    onSuccess: leave,
    onError: fail,
  });
  const cancelOrder = useMutation({
    mutationFn: (reason: string) =>
      api(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: leave,
    onError: (value) => {
      refresh();
      setCancelError(value instanceof ApiError ? value.message : 'Adisyon iptal edilemedi.');
    },
  });

  const currentOrder = order.data;
  // Yaniti kaybolan ekleme sunucuda uygulanmissa (tazelenen adisyonda o anahtar var) anahtar
  // birakilir: garsonun ayni urune bilerek yapacagi ikinci dokunus yeni kalem acar.
  useEffect(() => {
    const key = pendingAdd.current?.key;
    if (key && currentOrder?.items.some((item: ServerItem) => item.clientOpId === key)) {
      pendingAdd.current = null;
    }
  }, [currentOrder]);
  useEffect(() => {
    if (local && currentOrder?.serverId) {
      void draftDelete(id);
      nav(`/orders/${currentOrder.serverId}`, { replace: true, state: { phoneView } });
    }
  }, [local, currentOrder?.serverId, id, nav, phoneView]);

  const cats = categories.data ?? [];
  const cat = activeCat || cats[0]?.id || '';
  const query = search.trim().toLocaleLowerCase('tr-TR');
  const visibleProducts = (products.data ?? []).filter((product) =>
    query ? product.name.toLocaleLowerCase('tr-TR').includes(query) : product.categoryId === cat,
  );
  const canPay = hasPerm('payment.take');
  // Odeme ve kasa yalniz ana bilgisayarda (OFFLINE_DESIGN K3): baglanti yokken tahsilat alinmaz,
  // cift tahsilat ya da kasa farki olusmaz. Kullaniciya nedeni yazilir.
  const payNeedsServer = canPay && (local || offline);
  const canVoid = hasPerm('order.cancel');
  const pendingCount = (currentOrder?.items ?? []).filter(
    (item) => item.status === 'pending',
  ).length;
  const hasPending = pendingCount > 0;
  const activeItems = (currentOrder?.items ?? []).filter((item) => item.status !== 'cancelled');
  const isOpen = !local && currentOrder?.status === 'open';
  const place = orderPlace(currentOrder, tables.data, halls.data);
  const cashBlocked = cashStatus.data?.open === false;
  const busy =
    cashBlocked ||
    addItem.isPending ||
    sendKitchen.isPending ||
    updateQty.isPending ||
    removeItem.isPending ||
    voidItem.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f5f5f2] md:flex-row">
      <main
        className={`order-1 min-h-0 min-w-0 flex-1 flex-col md:flex ${
          phoneView === 'order' ? 'hidden' : 'flex'
        }`}
      >
        <header className="border-b border-stone-200/80 bg-[#f5f5f2]/95 px-4 py-3 backdrop-blur sm:px-5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => nav('/')}
              aria-label="Masa planına dön"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-stone-200 bg-white text-xl text-ink-800 shadow-sm transition hover:bg-stone-50"
            >
              ←
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[10px] font-bold tracking-[0.16em] text-brand-700 uppercase">
                {place.caption}
              </p>
              <h1
                data-testid="order-title"
                className="truncate text-lg font-black text-ink-900 sm:text-xl"
              >
                {place.title}
              </h1>
            </div>
            {/* Telefonda adisyon paneli gizliyken baglanti durumu burada gorunur. */}
            <div className="shrink-0 md:hidden">
              <SyncBadge testId="sync-badge-phone" />
            </div>
            <label className="relative hidden w-full max-w-xs xl:block">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-stone-400">
                ⌕
              </span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Ürün ara"
                className="h-11 w-full rounded-xl border border-stone-200 bg-white pr-3 pl-9 text-sm font-medium text-ink-900 shadow-sm placeholder:text-stone-400"
              />
            </label>
          </div>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Ürün ara"
            className="mt-3 h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm font-medium text-ink-900 shadow-sm placeholder:text-stone-400 xl:hidden"
          />
          {cashBlocked && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span>Kasa kapalı; bu adisyonda işlem yapılamaz.</span>
              {hasPerm('cash.manage') && (
                <button onClick={() => nav('/cash')} className="shrink-0 font-black underline">
                  Kasaya git
                </button>
              )}
            </div>
          )}
        </header>

        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-stone-200 bg-white px-4 py-3 sm:px-5">
          {cats.map((category) => (
            <button
              key={category.id}
              data-testid={`category-${category.id}`}
              onClick={() => {
                setSearch('');
                setActiveCat(category.id);
              }}
              className={`min-h-10 whitespace-nowrap rounded-xl px-4 text-sm font-bold transition ${
                !query && category.id === cat
                  ? 'bg-ink-900 text-white'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>

        {/* md'de sag panel acilir, urun alani daralir: 2 sutun (dar kartta ad kesiliyordu). */}
        <div className="grid flex-1 auto-rows-[minmax(112px,auto)] grid-cols-2 content-start gap-3 overflow-auto p-4 sm:grid-cols-3 sm:p-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {visibleProducts.map((product) => {
            // Tukenen urun gorunur kalir ama eklenemez (sunucu da PRODUCT_UNAVAILABLE ile reddeder).
            const soldOut = product.isAvailable === false;
            return (
              <button
                key={product.id}
                data-testid={`product-${product.id}`}
                onClick={() => addItem.mutate(product)}
                disabled={busy || soldOut}
                className={`group relative flex min-h-28 flex-col items-start justify-between overflow-hidden rounded-2xl border border-stone-200 bg-white p-4 text-left shadow-sm transition duration-150 disabled:opacity-50 ${
                  soldOut
                    ? 'cursor-not-allowed'
                    : 'hover:-translate-y-0.5 hover:border-brand-500 hover:shadow-panel active:translate-y-0'
                }`}
              >
                <span className="line-clamp-3 text-sm font-bold [overflow-wrap:anywhere] text-ink-900 sm:text-base">
                  {product.name}
                </span>
                <span className="mt-2 flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-black text-brand-700">
                    {formatKurus(product.salePrice)}
                  </span>
                  {soldOut ? (
                    <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                      Tükendi
                    </span>
                  ) : (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-lg font-semibold text-brand-700 transition group-hover:bg-brand-600 group-hover:text-white">
                      +
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {visibleProducts.length === 0 && !products.isLoading && (
            <div className="col-span-full rounded-2xl border border-dashed border-stone-300 bg-white/50 p-8 text-center">
              <p className="font-bold text-ink-800">Ürün bulunamadı</p>
              <p className="mt-1 text-sm text-stone-500">Başka bir kategori veya arama deneyin.</p>
            </div>
          )}
        </div>

        {/* Telefon: adisyon ayri gorunumde; alttaki serit ozeti gosterir, dokununca adisyon acilir. */}
        <div className="border-t border-stone-200 bg-white p-3 md:hidden">
          {error && (
            <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          )}
          <button
            data-testid="show-order"
            onClick={() => setPhoneView('order')}
            className="flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl bg-ink-900 px-4 text-left text-white transition active:scale-[0.98]"
          >
            <span className="min-w-0">
              <span className="block text-sm font-black">Adisyonu gör</span>
              <span className="block truncate text-xs text-white/70">
                {activeItems.length} kalem
                {hasPending && ` · ${pendingCount} mutfağa gönderilmedi`}
              </span>
            </span>
            <span className="shrink-0 text-lg font-black">
              {formatKurus(currentOrder?.grandTotal ?? 0)} →
            </span>
          </button>
        </div>
      </main>

      <aside
        className={`order-2 min-h-0 w-full flex-1 flex-col bg-white md:flex md:h-full md:w-[360px] md:flex-none md:shrink-0 md:border-l md:border-stone-200 md:shadow-[-12px_0_30px_rgba(21,32,29,0.04)] xl:w-[390px] ${
          phoneView === 'order' ? 'flex' : 'hidden'
        }`}
      >
        <header className="border-b border-stone-200 px-4 py-4">
          <div className="mb-3 flex items-center gap-3 md:hidden">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[10px] font-bold tracking-[0.16em] text-brand-700 uppercase">
                {place.caption}
              </p>
              <p className="truncate text-base font-black text-ink-900">{place.title}</p>
            </div>
            <button
              data-testid="show-products"
              onClick={() => setPhoneView('products')}
              className="min-h-11 shrink-0 rounded-xl bg-brand-50 px-4 text-sm font-black text-brand-700 transition active:scale-[0.98]"
            >
              + Ürün ekle
            </button>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-black text-ink-900" title={currentOrder?.orderNo}>
                  Adisyon #{currentOrder?.orderNo?.split('-')[1] ?? currentOrder?.orderNo ?? ''}
                </h2>
                {/* Cevrimdisi taslakta tur yoktur (yalniz masa); "Gel-al" yazmasin. */}
                {currentOrder?.type && currentOrder.type !== 'dine_in' && (
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] font-bold tracking-wide uppercase ${
                      currentOrder?.type === 'delivery'
                        ? 'bg-sky-100 text-sky-700'
                        : 'bg-brand-100 text-brand-700'
                    }`}
                  >
                    {currentOrder?.type === 'delivery' ? 'Paket' : 'Gel-al'}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-stone-500">
                {(currentOrder?.items ?? []).length} kalem
              </p>
            </div>
            <SyncBadge />
          </div>
          {currentOrder?.status === 'open' && currentOrder.tableId && !local && !offline && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              <SmallAction onClick={() => setTransfer('move')}>Taşı</SmallAction>
              <SmallAction onClick={() => setTransfer('merge')}>Birleştir</SmallAction>
              <SmallAction
                onClick={() => setSplitOpen(true)}
                disabled={(currentOrder?.items ?? []).length < 2}
              >
                Böl
              </SmallAction>
            </div>
          )}
        </header>

        <ul className="min-h-0 flex-1 space-y-2 overflow-auto bg-stone-50/70 p-3">
          {!local && currentOrder?.fromSnapshot && (
            <li
              data-testid="order-from-snapshot"
              className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
            >
              Bağlantı yok: adisyonun son bilinen hali gösteriliyor. Eklediğiniz ürünler bu tablette
              saklanır, bağlantı gelince gönderilir.
            </li>
          )}
          {local && (currentOrder as { review?: unknown } | undefined)?.review !== undefined && (
            <li
              data-testid="draft-review"
              className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
            >
              Bu sipariş yönetici onayı bekliyor. Onaylanınca adisyon kendiliğinden açılır;
              reddedilirse size bildirilir.
            </li>
          )}
          <OrderProblems orderId={id} />
          {(currentOrder?.items ?? []).length === 0 && (
            <li className="flex min-h-32 flex-col items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-white text-center">
              <span className="text-sm font-bold text-ink-800">Adisyon boş</span>
              <span className="mt-1 text-xs text-stone-500">Soldan bir ürün seçerek başlayın.</span>
            </li>
          )}
          {(currentOrder?.items ?? []).map((item: ServerItem) => {
            const pending = item.status === 'pending';
            const cancelled = item.status === 'cancelled';
            const shadow = isShadow(item);
            // Baglanti yokken sunucu kalemi degistirilemez (cevrimdisi eklenenler degistirilir).
            const locked = offline && !local && !shadow;
            return (
              <li
                key={item.id}
                data-testid="order-item"
                className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span
                      className={`block truncate text-sm font-bold ${
                        cancelled ? 'text-stone-400 line-through' : 'text-ink-900'
                      }`}
                    >
                      {item.productNameSnapshot}
                    </span>
                    {(item.notes ?? []).length > 0 && (
                      <span
                        data-testid="item-note"
                        className="mt-0.5 block text-xs font-semibold break-words text-amber-700"
                      >
                        Not: {(item.notes ?? []).map((n) => n.note).join('; ')}
                      </span>
                    )}
                    {shadow ? (
                      <span
                        data-testid="item-offline"
                        className="mt-0.5 block text-[10px] font-bold tracking-wide text-amber-700 uppercase"
                      >
                        {pending
                          ? 'Bu tablette · bağlantı gelince eklenecek'
                          : 'Bağlantı gelince mutfağa gidecek'}
                      </span>
                    ) : cancelled ? (
                      <span className="mt-0.5 block text-[10px] font-bold tracking-wide text-red-600 uppercase">
                        İptal edildi{item.voidReason ? ` · ${item.voidReason}` : ''}
                      </span>
                    ) : (
                      !pending && (
                        <span className="mt-0.5 block text-[10px] font-bold tracking-wide text-brand-700 uppercase">
                          Mutfağa gönderildi
                        </span>
                      )
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-sm font-black ${
                      cancelled ? 'text-stone-400 line-through' : 'text-ink-900'
                    }`}
                  >
                    {formatKurus(item.lineTotal)}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  {pending ? (
                    <>
                      <QtyButton
                        label="Azalt"
                        onClick={() =>
                          item.quantity <= 1000
                            ? removeItem.mutate({ itemId: item.id, shadow })
                            : updateQty.mutate({
                                itemId: item.id,
                                quantity: item.quantity - 1000,
                                shadow,
                              })
                        }
                        disabled={busy || locked}
                      >
                        −
                      </QtyButton>
                      <span className="min-w-9 text-center text-sm font-black text-ink-900">
                        {formatQty(item.quantity)}
                      </span>
                      <QtyButton
                        label="Artır"
                        onClick={() =>
                          updateQty.mutate({
                            itemId: item.id,
                            quantity: item.quantity + 1000,
                            shadow,
                          })
                        }
                        disabled={busy || locked || item.quantity + 1000 > MAX_QUANTITY_MILLI}
                      >
                        +
                      </QtyButton>
                      {!local && !shadow && (
                        <button
                          data-testid="item-note-button"
                          onClick={() => setNoteItem(item)}
                          disabled={busy || locked}
                          className="ml-auto min-h-10 rounded-xl px-3 text-xs font-bold text-ink-700 hover:bg-stone-100"
                        >
                          Not
                        </button>
                      )}
                      <button
                        onClick={() => removeItem.mutate({ itemId: item.id, shadow })}
                        disabled={busy || locked}
                        className={`${local || shadow ? 'ml-auto ' : ''}min-h-10 rounded-xl px-3 text-xs font-bold text-red-600 hover:bg-red-50`}
                      >
                        Sil
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs font-semibold text-stone-500">
                        {formatQty(item.quantity)} adet
                      </span>
                      {canVoid && !cancelled && !shadow && (
                        <button
                          onClick={() => {
                            setVoidError('');
                            setVoidFor(item);
                          }}
                          disabled={busy || locked}
                          className="ml-auto min-h-11 rounded-xl px-4 text-xs font-bold text-red-600 hover:bg-red-50"
                        >
                          İptal
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-stone-200 bg-white p-4">
          {(currentOrder?.discountTotal ?? 0) > 0 && (
            <div className="mb-1 flex items-center justify-between text-sm text-stone-500">
              <span>İndirim</span>
              <span>−{formatKurus(currentOrder?.discountTotal ?? 0)}</span>
            </div>
          )}
          <div className="mb-3 flex items-end justify-between">
            <span className="text-xs font-bold tracking-wide text-stone-500 uppercase">Toplam</span>
            <span className="text-3xl font-black tracking-tight text-ink-900">
              {formatKurus(currentOrder?.grandTotal ?? 0)}
            </span>
          </div>
          {error && (
            <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          )}
          {isOpen && canPay && activeItems.length > 0 && (currentOrder?.grandTotal ?? 0) <= 0 && (
            <button
              data-testid="close-order"
              onClick={() => closeOrder.mutate()}
              disabled={closeOrder.isPending || hasPending}
              className="mb-2 min-h-12 w-full rounded-2xl bg-brand-600 text-sm font-black text-white transition hover:bg-brand-700 disabled:opacity-40"
            >
              {hasPending ? 'Önce mutfağa gönderin' : 'Adisyonu kapat (ödeme yok)'}
            </button>
          )}
          {isOpen && activeItems.length === 0 && (
            <button
              data-testid="discard-order"
              onClick={() => discard.mutate()}
              disabled={discard.isPending}
              className="mb-2 min-h-12 w-full rounded-2xl border border-red-200 bg-red-50 text-sm font-black text-red-700 transition hover:bg-red-100 disabled:opacity-40"
            >
              {currentOrder?.tableId ? 'Masayı kapat (boş adisyon)' : 'Adisyonu kapat (boş)'}
            </button>
          )}
          <div className={`mb-2 grid gap-2 ${canVoid ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <SmallAction
              onClick={() => setDiscountOpen(true)}
              disabled={busy || local || offline || !currentOrder || currentOrder.status !== 'open'}
            >
              İndirim
            </SmallAction>
            <SmallAction
              onClick={() => hold.mutate()}
              disabled={
                busy ||
                local ||
                offline ||
                hold.isPending ||
                !currentOrder ||
                currentOrder.status !== 'open'
              }
            >
              Beklet
            </SmallAction>
            <SmallAction
              onClick={() => printBill.mutate()}
              disabled={
                busy ||
                local ||
                offline ||
                printBill.isPending ||
                !currentOrder ||
                (currentOrder?.items ?? []).length === 0
              }
            >
              {printBill.isPending ? 'Yazılıyor…' : 'Hesap'}
            </SmallAction>
            {canVoid && (
              <SmallAction
                onClick={() => {
                  setCancelError('');
                  setCancelOpen(true);
                }}
                disabled={!isOpen || offline || activeItems.length === 0 || cancelOrder.isPending}
              >
                İptal et
              </SmallAction>
            )}
          </div>
          <div className={`grid gap-2 ${canPay ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <button
              data-testid="send-kitchen"
              onClick={() => sendKitchen.mutate()}
              disabled={busy || !hasPending}
              className="min-h-14 rounded-2xl bg-ink-900 px-3 text-sm font-black text-white transition hover:bg-ink-800 active:scale-[0.98] disabled:opacity-35"
            >
              Mutfağa gönder
            </button>
            {canPay && (
              <button
                onClick={() => setPayOpen(true)}
                disabled={busy || payNeedsServer || !currentOrder || currentOrder.grandTotal <= 0}
                className="min-h-14 rounded-2xl bg-brand-600 px-3 text-sm font-black text-white transition hover:bg-brand-700 active:scale-[0.98] disabled:opacity-35"
              >
                Ödeme al
              </button>
            )}
          </div>
          {payNeedsServer && (
            <p
              data-testid="pay-offline-hint"
              className="mt-2 text-center text-xs font-medium text-stone-500"
            >
              Ödeme için ana bilgisayara bağlantı gerekir.{' '}
              {local
                ? 'Sipariş bu cihazda saklandı; bağlantı gelince gönderilir.'
                : 'Bağlantı gelince ödeme alınabilir.'}
            </p>
          )}
        </div>
      </aside>

      {payOpen && currentOrder && (
        <PaymentModal
          orderId={id}
          grandTotal={currentOrder.grandTotal}
          onClose={() => setPayOpen(false)}
          onCompleted={() => nav('/', { replace: true })}
        />
      )}
      {discountOpen && currentOrder && (
        <DiscountModal
          orderId={id}
          discounts={currentOrder.discounts ?? []}
          onClose={() => setDiscountOpen(false)}
        />
      )}
      {transfer && currentOrder && (
        <TableTransferModal
          orderId={id}
          currentTableId={currentOrder.tableId}
          mode={transfer}
          onClose={() => setTransfer(null)}
          onDone={() => {
            setTransfer(null);
            if (transfer === 'move') nav('/', { replace: true });
          }}
        />
      )}
      {noteItem && (
        <TextPromptModal
          title="Ürün notu"
          description={`${noteItem.productNameSnapshot} — mutfak fişinde ürünün altına basılır.`}
          label="Not"
          initialValue={(noteItem.notes ?? []).map((n) => n.note).join('; ')}
          placeholder="ör. az pişmiş, soğansız"
          minLength={0}
          busy={saveNote.isPending}
          onConfirm={(note) => saveNote.mutate({ itemId: noteItem.id, note })}
          onClose={() => setNoteItem(null)}
        />
      )}
      {cancelOpen && (
        <ReasonModal
          title="Adisyonu iptal et"
          description="Adisyon kapatılır ve masa boşalır. Ödeme alınmışsa önce Kasa ekranından iade edin."
          reasons={CANCEL_REASONS}
          confirmLabel="Adisyonu iptal et"
          busy={cancelOrder.isPending}
          error={cancelError}
          onConfirm={(reason) => cancelOrder.mutate(reason)}
          onClose={() => setCancelOpen(false)}
        />
      )}
      {voidFor && (
        <ReasonModal
          title="Kalemi iptal et"
          description={`${formatQty(voidFor.quantity)} × ${voidFor.productNameSnapshot} · ${formatKurus(
            voidFor.lineTotal,
          )} — mutfağa gönderilmiş kalem iptal edilir ve adisyondan düşülür.`}
          reasons={VOID_REASONS}
          confirmLabel="Kalemi iptal et"
          busy={voidItem.isPending}
          error={voidError}
          onConfirm={(reason) => voidItem.mutate({ itemId: voidFor.id, reason })}
          onClose={() => setVoidFor(null)}
        />
      )}
      {splitOpen && currentOrder && (
        <SplitModal
          orderId={id}
          items={currentOrder.items}
          onClose={() => setSplitOpen(false)}
          onDone={(createdOrderId) => {
            setSplitOpen(false);
            nav(`/orders/${createdOrderId}`, { replace: true });
          }}
        />
      )}
    </div>
  );
}

// Baslik: salon + masa; masasiz adisyonda tur + sira no. Tur bilinmiyorsa (taslak) masa.
function orderPlace(
  order: Order | undefined,
  tables: Table[] | undefined,
  halls: Hall[] | undefined,
): { caption: string; title: string } {
  if (!order) return { caption: 'Ürün seçimi', title: 'Adisyon' };
  const no = `#${order.orderNo?.split('-')[1] ?? order.orderNo ?? ''}`;
  if (order.type === 'delivery') return { caption: 'Paket sipariş', title: no };
  if (order.type === 'takeaway') return { caption: 'Gel-al sipariş', title: no };
  const table = order.table ?? tables?.find((t) => t.id === order.tableId);
  const tableHallId = tables?.find((t) => t.id === order.tableId)?.hallId;
  const hall = order.table?.hall?.name ?? halls?.find((h) => h.id === tableHallId)?.name;
  return { caption: hall ?? 'Masa', title: table?.name ?? 'Masa' };
}

function SmallAction({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="min-h-10 rounded-xl border border-stone-200 bg-white px-2 text-xs font-bold text-stone-600 transition hover:bg-stone-50 disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function QtyButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-10 w-10 items-center justify-center rounded-xl bg-stone-100 text-lg font-black text-ink-900 transition hover:bg-stone-200 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

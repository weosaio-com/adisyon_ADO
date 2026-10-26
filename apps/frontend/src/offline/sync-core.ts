// Istemci-offline saf mantik (tarayici bagimsiz -> node ile self-check edilebilir).
// OFFLINE_DESIGN.md §5-§8. Self-check: sync-core.selfcheck.ts
export type MutationType =
  'OPEN_TABLE' | 'ADD_LINE' | 'UPDATE_LINE_QTY' | 'ADD_NOTE' | 'SUBMIT_ORDER';

export interface OutboxEntry {
  clientOpId: string; // ULID -> PK (idempotency anahtari)
  type: MutationType;
  payload: Record<string, unknown>;
  localOrderId: string; // ait oldugu local draft ('local:<ulid>') ya da sunucu adisyon id'si
  status: 'pending' | 'inflight';
  retryCount: number;
  createdAt: number;
  /** Artan sira numarasi (db.enqueue verir): gonderim sirasi tablet saatine bagli degil. */
  seq?: number;
  /** Ekranda gosterilecek adisyon adi (masa); sunucuya gonderilmez. */
  label?: string;
  /** Kaydin ait oldugu masa (sorun isareti icin); sunucuya gonderilmez. */
  tableId?: string | null;
}

/** Gonderim sirasi: seq; seq'siz eski kayitlar once (ULID sirasiyla). OFFLINE_DESIGN.md §6 */
export function compareOutbox(a: OutboxEntry, b: OutboxEntry): number {
  const bySeq = (a.seq ?? -1) - (b.seq ?? -1);
  if (bySeq !== 0) return bySeq;
  return a.clientOpId < b.clientOpId ? -1 : a.clientOpId > b.clientOpId ? 1 : 0;
}

export interface DraftItem {
  id: string; // ADD_LINE clientOpId'si = local satir id'si
  productId: string;
  productNameSnapshot: string;
  quantity: number; // milis (1000 = 1 adet)
  lineTotal: number; // kurus
  status: 'pending' | 'sent';
}

export interface DraftOrder {
  id: string; // 'local:<ulid>'
  clientOpId: string; // OPEN_TABLE clientOpId (mutasyon referansi)
  orderNo: string;
  tableId: string | null;
  status: 'open';
  items: DraftItem[];
  subtotal: number;
  discountTotal: number;
  grandTotal: number;
  serverId?: string; // sync sonrasi gercek order id
  /** Sunucuya gecis zamani: bir sure sonra taslak silinir (ekran yonlenmis olur). */
  syncedAt?: number;
  /** OPEN_TABLE yonetici onayina dustu: masa planinda "senkron bekliyor" gosterilmez (OFF-8). */
  review?: { reviewId?: string; reason: string };
}

// POST /sync/mutations yanit satiri. OFFLINE_DESIGN.md §7.1
export interface MutationResult {
  clientOpId: string;
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  serverId?: string;
  reviewId?: string;
  reason?: string;
}

export function lineTotal(salePrice: number, qtyMilis: number): number {
  return Math.round((salePrice * qtyMilis) / 1000);
}

/**
 * Sunucuda acik adisyona cevrimdisi eklenen kalemlerin yerel kaydi ("golge" taslak, OFF-4):
 * id = 'shadow:<sunucu adisyon id>', serverId = sunucu adisyonu. Kalemler sunucuya gecince
 * golgeden silinir; ekran sunucu (ya da snapshot) adisyonunu golge kalemleriyle birlestirir.
 */
export const SHADOW_PREFIX = 'shadow:';
export function shadowDraft(order: {
  id: string;
  label: string;
  tableId: string | null;
}): DraftOrder {
  return {
    id: SHADOW_PREFIX + order.id,
    clientOpId: '',
    orderNo: order.label,
    tableId: order.tableId,
    status: 'open',
    items: [],
    subtotal: 0,
    discountTotal: 0,
    grandTotal: 0,
    serverId: order.id,
  };
}
/** Golge taslakta adisyon referansi sunucu id'si, taslakta OPEN_TABLE'in clientOpId'si. */
function orderRef(draft: DraftOrder): Record<string, string> {
  return draft.id.startsWith(SHADOW_PREFIX) && draft.serverId
    ? { orderId: draft.serverId }
    : { orderClientOpId: draft.clientOpId };
}

type Totals = Pick<DraftOrder, 'subtotal' | 'discountTotal' | 'grandTotal'>;
// Offline draft toplamlari yaklasiktir (KDV/indirim sunucuda kesinlesir). §5.2
export function recompute(items: DraftItem[]): Totals {
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  return { subtotal, discountTotal: 0, grandTotal: subtotal };
}

export function buildOpenTable(
  ids: { orderId: string; clientOpId: string },
  tableId: string | null,
  orderNo: string,
): { draft: DraftOrder; entry: OutboxEntry } {
  const draft: DraftOrder = {
    id: ids.orderId,
    clientOpId: ids.clientOpId,
    orderNo,
    tableId,
    status: 'open',
    items: [],
    subtotal: 0,
    discountTotal: 0,
    grandTotal: 0,
  };
  const entry: OutboxEntry = {
    clientOpId: ids.clientOpId,
    type: 'OPEN_TABLE',
    payload: { tableId },
    localOrderId: ids.orderId,
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now(),
  };
  return { draft, entry };
}

export function buildAddLine(
  draft: DraftOrder,
  lineId: string,
  product: { id: string; name: string; salePrice: number },
  qtyMilis = 1000,
): { draft: DraftOrder; entry: OutboxEntry } {
  const item: DraftItem = {
    id: lineId,
    productId: product.id,
    productNameSnapshot: product.name,
    quantity: qtyMilis,
    lineTotal: lineTotal(product.salePrice, qtyMilis),
    status: 'pending',
  };
  const items = [...draft.items, item];
  const entry: OutboxEntry = {
    clientOpId: lineId,
    type: 'ADD_LINE',
    // unitPrice: garsonun gordugu fiyat; sunucu farkliysa kalemi onaya alir (OFF-3).
    // productName: onay ekraninda ve sorun listesinde urun adi (sunucu yok sayar).
    payload: {
      ...orderRef(draft),
      productId: product.id,
      quantity: qtyMilis,
      unitPrice: product.salePrice,
      productName: product.name,
    },
    localOrderId: draft.id,
    tableId: draft.tableId,
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now(),
  };
  return { draft: { ...draft, items, ...recompute(items) }, entry };
}

export function buildSubmit(
  draft: DraftOrder,
  opId: string,
): { draft: DraftOrder; entry: OutboxEntry } {
  const items = draft.items.map((i) => ({ ...i, status: 'sent' as const }));
  const entry: OutboxEntry = {
    clientOpId: opId,
    type: 'SUBMIT_ORDER',
    payload: orderRef(draft),
    localOrderId: draft.id,
    tableId: draft.tableId,
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now(),
  };
  return { draft: { ...draft, items }, entry };
}

// ---------------------------------------------------------------------------
// Gonderim (drain): dilimleme + hata siniflandirma. OFF-1
// ---------------------------------------------------------------------------

/** Tek istekte en cok bu kadar kayit (sunucu siniri 200) ve yaklasik govde boyutu. */
export const CHUNK_MAX_COUNT = 100;
export const CHUNK_MAX_BYTES = 64 * 1024;

/** Sunucuya giden mutasyon (outbox kaydinin tel bicimi). */
export function wireMutation(entry: OutboxEntry): {
  clientOpId: string;
  type: MutationType;
  payload: Record<string, unknown>;
} {
  return { clientOpId: entry.clientOpId, type: entry.type, payload: entry.payload };
}

export function wireSize(entry: OutboxEntry): number {
  return new TextEncoder().encode(JSON.stringify(wireMutation(entry))).length;
}

/**
 * Outbox'i sirayi bozmadan dilimlere ayirir: her dilim en cok `maxCount` kayit ve yaklasik
 * `maxBytes` bayt. Siniri tek basina asan kayit kendi diliminde gider. Dilimler sirayla
 * gonderilir: OPEN_TABLE her zaman kendisine bagli kalemlerden once islenir.
 */
export function chunkEntries<T extends OutboxEntry>(
  entries: T[],
  maxCount = CHUNK_MAX_COUNT,
  maxBytes = CHUNK_MAX_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = wireSize(entry) + 1;
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Basarisiz gonderim istegi ne yapilacagini belirler:
 * - offline: sunucuya hic ulasilamadi (ag / zaman asimi) -> "Çevrimdışı", sonra tekrar.
 * - retry: sunucu ulasilir ama simdi kabul edemiyor (5xx, mesgul, yaris 409, 429) -> bekle.
 * - blocked: oturum / yetki (401, 403) -> giris ya da yetki gerekir, kayitlar korunur.
 * - split: istegin kendisi reddedildi (400/413/422...) -> dilim bolunur; tek kayitsa o kayit
 *   ayrilir (sorun listesine), kalanlar gonderilmeye devam eder. Kuyruk takilmaz.
 */
export type FailureKind = 'offline' | 'retry' | 'blocked' | 'split';
export function classifyFailure(status: number, code: string): FailureKind {
  if (status === 0) return 'offline';
  if (status === 413 || code === 'PAYLOAD_TOO_LARGE') return 'split';
  if (status === 401 || status === 403) return 'blocked';
  if (status === 404 || status === 408 || status === 409 || status === 429 || status >= 500) {
    return 'retry';
  }
  return status >= 400 ? 'split' : 'retry';
}

// ---------------------------------------------------------------------------
// Senkron sorunlari: sunucunun kabul etmedigi ya da onaya aldigi kayitlar (garsona gosterilir).
// ---------------------------------------------------------------------------

export interface SyncProblem {
  id: string; // ilgili mutasyonun clientOpId'si
  kind: 'rejected' | 'conflict' | 'failed';
  type: MutationType;
  reason: string; // sunucu nedeni (PRODUCT_INACTIVE, cash_closed...) ya da HTTP kodu
  message: string; // garsona gosterilen Turkce aciklama
  what: string; // "2 × Ayran" / "Masa açma" gibi kisa tanim
  localOrderId: string; // taslak ('local:...') ya da sunucu adisyon id'si
  /** Sunucu adisyonu (biliniyorsa): taslak sunucuya gecince isaret orada da gorunur. */
  serverOrderId?: string;
  tableId?: string | null;
  orderLabel: string; // "Masa 5" / "Adisyon"
  reviewId?: string;
  createdAt: number;
}

/** Bu adisyona (taslak ya da sunucu id'si) ait sorunlar. */
export function problemsForOrder(problems: SyncProblem[], orderId: string): SyncProblem[] {
  return problems.filter((p) => p.localOrderId === orderId || p.serverOrderId === orderId);
}

const QTY = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 });

/** Kaydin kisa tanimi: kalemde urun adi ve adet, digerlerinde islem adi. */
export function describeEntry(entry: OutboxEntry, draft?: DraftOrder): string {
  if (entry.type === 'ADD_LINE') {
    const item = draft?.items.find((i) => i.id === entry.clientOpId);
    const name = item?.productNameSnapshot ?? String(entry.payload.productName ?? 'Ürün');
    const qty = Number(entry.payload.quantity ?? item?.quantity ?? 1000) / 1000;
    return `${QTY.format(qty)} × ${name}`;
  }
  if (entry.type === 'OPEN_TABLE') return 'Masa açma';
  if (entry.type === 'SUBMIT_ORDER') return 'Mutfağa gönderme';
  if (entry.type === 'UPDATE_LINE_QTY') return 'Adet değişikliği';
  if (entry.type === 'ADD_NOTE') return 'Not';
  return 'İşlem';
}

const CONFLICT_TEXT: Record<string, string> = {
  cash_closed: 'Kasa kapalıyken gönderildi',
  table_closed: 'Adisyon bu arada kapatılmış',
  table_moved: 'Masa taşınmış ya da birleştirilmiş',
  product_inactive: 'Ürün satışa kapatılmış',
  price_changed: 'Ürünün fiyatı değişmiş',
};
const REJECT_TEXT: Record<string, string> = {
  PRODUCT_INACTIVE: 'ürün satışa kapalı olduğu için eklenemedi',
  PRODUCT_UNAVAILABLE: 'ürün tükendiği için eklenemedi',
  LICENSE_LOCKED: 'lisans kilitli olduğu için yeni adisyon açılamadı',
  ORDER_NOT_OPENED: 'adisyon açılamadığı için eklenemedi',
  REVIEW_REJECTED: 'yönetici reddetti; müşteriye bilgi verin',
  AMOUNT_LIMIT_EXCEEDED: 'tutar sınırı aşıldığı için kabul edilmedi',
};

/** Sunucu sonucundan garsonun anlayacagi aciklama. */
export function problemMessage(kind: SyncProblem['kind'], reason: string, what: string): string {
  if (kind === 'conflict') {
    return `${what}: ${CONFLICT_TEXT[reason] ?? 'Sunucuda çakışma oldu'}; yönetici onayı bekliyor.`;
  }
  const text = REJECT_TEXT[reason];
  if (text) return `${what}: ${text}.`;
  return `${what}: sunucu bu işlemi kabul etmedi (${reason}). Yöneticinize haber verin.`;
}

export interface DrainOutcome {
  remove: string[]; // outbox'tan silinecek clientOpId'ler
  serverIdByOpId: Record<string, string>; // applied -> gercek server id
  conflicts: MutationResult[];
  rejections: MutationResult[];
}

// Sunucu sonuclarini outbox aksiyonlarina cevir. applied/duplicate -> sil;
// conflict -> sil (sunucu Owner review kuyruguna aldi); rejected -> sil + garsona bildir.
export function applyResults(results: MutationResult[]): DrainOutcome {
  const out: DrainOutcome = { remove: [], serverIdByOpId: {}, conflicts: [], rejections: [] };
  for (const r of results) {
    out.remove.push(r.clientOpId);
    if (r.status === 'applied' || r.status === 'duplicate') {
      if (r.serverId) out.serverIdByOpId[r.clientOpId] = r.serverId;
    } else if (r.status === 'conflict') {
      out.conflicts.push(r);
    } else {
      out.rejections.push(r);
    }
  }
  return out;
}

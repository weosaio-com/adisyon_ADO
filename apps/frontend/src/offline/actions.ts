// Ekranlarin cagirdigi offline aksiyonlar: draft yaz + outbox'a kuyrukla + drain tetikle.
import { ulid } from './ids';
import {
  buildOpenTable,
  buildAddLine,
  buildSubmit,
  recompute,
  shadowDraft,
  SHADOW_PREFIX,
  type DraftOrder,
} from './sync-core';
import { draftGet, enqueue, outboxGet, saveDraftAndOutbox } from './db';
import { kick } from './engine';
import { sessionClaims } from '../lib/api';

export const LOCAL_PREFIX = 'local:';
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_PREFIX);
}

/** Garsona aynen gosterilecek hata (cevrimdisi islem yapilamadi). */
export class OfflineActionError extends Error {}

/** Gonderilmekte olan kalem degistirilemez: sunucu eski hali uygulamis olabilir (OFF-11). */
export const INFLIGHT_MESSAGE = 'Bu kalem şu an gönderiliyor; birkaç saniye sonra tekrar deneyin.';
const STORAGE_FULL_MESSAGE =
  'Tablet depolaması dolu; sipariş bu cihaza kaydedilemedi. Cihazda yer açıp tekrar deneyin.';

// Taslak + outbox kaydi tek IndexedDB isleminde yazilir (db.enqueue). Kayda olusturan
// kullanici eklenir: cikis yapilip baska garson girse de siparis olusturanin adina gider.
async function commit(draft: DraftOrder, entry: Parameters<typeof enqueue>[1][number]) {
  const actor = sessionClaims();
  try {
    await enqueue(draft, [{ ...entry, ...(actor ? { actor } : {}) }]);
  } catch (error) {
    // Kota doldu: garson siparisin kaydedilmedigini acikca gorsun (OFF-13).
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new OfflineActionError(STORAGE_FULL_MESSAGE);
    }
    throw error;
  }
  void kick();
}

// Masa ac (offline) -> local draft id doner. UI bu id ile OrderScreen'e gider.
export async function offlineOpenTable(tableId: string, tableName: string): Promise<string> {
  const op = ulid();
  const orderId = LOCAL_PREFIX + op;
  const { draft, entry } = buildOpenTable({ orderId, clientOpId: op }, tableId, `⏳ ${tableName}`);
  await commit(draft, entry);
  return orderId;
}

export async function offlineAddLine(
  orderId: string,
  product: { id: string; name: string; salePrice: number },
): Promise<void> {
  const d = await draftGet(orderId);
  if (!d) throw new Error('Taslak adisyon bulunamadi');
  const { draft, entry } = buildAddLine(d, ulid(), product);
  await commit(draft, entry);
}

export async function offlineSubmit(orderId: string): Promise<void> {
  const d = await draftGet(orderId);
  if (!d) throw new Error('Taslak adisyon bulunamadi');
  const { draft, entry } = buildSubmit(d, ulid());
  await commit(draft, entry);
}

// Gonderilmemis draft satir duzenleme = lokal, mutasyon degil. OFFLINE_DESIGN.md §5.3
export async function offlineUpdateQty(
  orderId: string,
  itemId: string,
  quantity: number,
): Promise<void> {
  const d = await draftGet(orderId);
  if (!d) return;
  const e = await outboxGet(itemId);
  if (e?.status === 'inflight') throw new OfflineActionError(INFLIGHT_MESSAGE);
  const items = d.items.map((i) =>
    i.id === itemId
      ? { ...i, quantity, lineTotal: Math.round((i.lineTotal / i.quantity) * quantity) }
      : i,
  );
  await saveDraftAndOutbox(
    { ...d, items, ...recompute(items) },
    e ? { put: [{ ...e, payload: { ...e.payload, quantity } }] } : {},
  );
  void kick();
}

export async function offlineRemoveLine(orderId: string, itemId: string): Promise<void> {
  const d = await draftGet(orderId);
  if (!d) return;
  const e = await outboxGet(itemId);
  if (e?.status === 'inflight') throw new OfflineActionError(INFLIGHT_MESSAGE);
  const items = d.items.filter((i) => i.id !== itemId);
  // gonderilmemis satir -> outbox'tan da cikar (ayni islemde)
  await saveDraftAndOutbox({ ...d, items, ...recompute(items) }, { remove: [itemId] });
  void kick();
}

/**
 * Sunucuda acik adisyona cevrimdisi kalem ekle (OFF-4): ADD_LINE {orderId} kuyruga yazilir,
 * kalem golge taslakta "bekliyor" olarak gosterilir.
 */
export async function offlineAddToServerOrder(
  order: { id: string; label: string; tableId: string | null },
  product: { id: string; name: string; salePrice: number },
): Promise<void> {
  const shadow = (await draftGet(SHADOW_PREFIX + order.id)) ?? shadowDraft(order);
  const { draft, entry } = buildAddLine(shadow, ulid(), product);
  await commit(draft, entry);
}

/** Sunucu adisyonuna cevrimdisi eklenen kalemleri mutfaga gonder: SUBMIT_ORDER {orderId}. */
export async function offlineSubmitServerOrder(orderId: string): Promise<void> {
  const shadow = await draftGet(SHADOW_PREFIX + orderId);
  if (!shadow) throw new Error('Gönderilecek çevrimdışı kalem yok');
  const { draft, entry } = buildSubmit(shadow, ulid());
  await commit(draft, entry);
}

export async function readLocalOrder(orderId: string): Promise<DraftOrder> {
  const d = await draftGet(orderId);
  if (!d) throw new Error('Taslak adisyon bulunamadi');
  return d;
}

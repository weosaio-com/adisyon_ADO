/**
 * Domain Event sozlesmesi — backend+frontend (Faz 2 WebSocket/sync) ortak kaynak.
 *
 * Kural: event adi `entity.action` ( or. 'order.created'). Her event ayni ZARF'i tasir;
 * yalnizca `payload` degisir. Yayinla/dinle mekanizmasi: EVENT_BUS.md.
 * Event katalogu ve dinleyiciler: DOMAIN_EVENTS.md.
 */
import { newId } from './id.js';

/** Tum domain event'lerin ortak zarfi. */
export interface DomainEvent<TName extends string = string, TPayload = unknown> {
  /** Bu event ornegi icin benzersiz ULID (idempotent isleme + izleme). */
  eventId: string;
  /** `entity.action` ( or. 'product.created'). */
  name: TName;
  /** Olusma ani (ISO 8601). */
  occurredAt: string;
  /** Kiracı/sube izolasyonu. */
  branchId: string;
  /** Islemi yapan kullanici (varsa). */
  actorId?: string;
  /** Kaynak cihaz (varsa; Waiter tableti vb.). */
  deviceId?: string;
  /** Iliskili islem zincirini baglar (or. requestId / clientOpId). */
  correlationId?: string;
  /** Event'e ozel veri. */
  payload: TPayload;
}

/** `createDomainEvent` icin ust veri (zarfi doldurur). */
export interface DomainEventMeta {
  branchId: string;
  actorId?: string;
  deviceId?: string;
  correlationId?: string;
}

/**
 * Zarfi standart sekilde uretir: eventId (ULID) + occurredAt otomatik doldurulur.
 * Yayincilar domain event'i her zaman bununla olusturur -> zarf tutarli kalir.
 */
export function createDomainEvent<TName extends string, TPayload>(
  name: TName,
  payload: TPayload,
  meta: DomainEventMeta,
): DomainEvent<TName, TPayload> {
  return {
    eventId: newId(),
    name,
    occurredAt: new Date().toISOString(),
    branchId: meta.branchId,
    ...(meta.actorId ? { actorId: meta.actorId } : {}),
    ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
    payload,
  };
}

/**
 * Bilinen domain event adlari. Modul geldikce buraya eklenir (DOMAIN_EVENTS.md ile senkron).
 * Su an: katalog (ilk uretici). Sipariş/ödeme/kasa vb. ilgili modul inşa edilirken eklenecek.
 */
export const DomainEventName = {
  CategoryCreated: 'category.created',
  CategoryUpdated: 'category.updated',
  CategoryDeleted: 'category.deleted',
  ProductCreated: 'product.created',
  ProductUpdated: 'product.updated',
  ProductDeleted: 'product.deleted',
  TableCreated: 'table.created',
  TableUpdated: 'table.updated',
  TableDeleted: 'table.deleted',
  HallCreated: 'hall.created',
  HallUpdated: 'hall.updated',
  HallDeleted: 'hall.deleted',
  BranchUpdated: 'branch.updated',
  LicenseActivated: 'license.activated',
  OrderCreated: 'order.created',
  OrderUpdated: 'order.updated',
  OrderItemAdded: 'order.item.added',
  OrderItemVoided: 'order.item.voided',
  OrderItemSent: 'order.item.sent',
  OrderPaid: 'order.paid',
  OrderRefunded: 'order.refunded',
} as const;

export type DomainEventName = (typeof DomainEventName)[keyof typeof DomainEventName];

// --- Katalog event payload'lari ---
export interface CategoryEventPayload {
  categoryId: string;
  name: string;
}

export interface ProductEventPayload {
  productId: string;
  name: string;
  categoryId: string;
  salePrice: number; // kurus
}

// --- Masa event payload'lari ---
export interface TableEventPayload {
  tableId: string;
  hallId: string;
  name: string;
}

export interface HallEventPayload {
  hallId: string;
  name: string;
}

// --- Isletme (sube) bilgisi: ad/adres/telefon degisti ---
export interface BranchEventPayload {
  name: string;
}

// --- Lisans: yeni anahtar etkinlestirildi. Anahtarin kendisi ASLA event'e konmaz. ---
export interface LicenseActivatedEventPayload {
  licenseId: string | null;
  customerName: string;
  features: Record<string, boolean>;
}

// --- Siparis event payload'lari ---
export interface OrderEventPayload {
  orderId: string;
  orderNo: string;
  tableId?: string;
  status: string;
  grandTotal: number; // kurus
}

export interface OrderItemEventPayload {
  orderId: string;
  orderItemId: string;
  productId: string;
  quantity: number; // milis
  lineTotal: number; // kurus
}

/**
 * Kalemler mutfaga/bara iletildiginde yayinlanir. Dinleyici: yazdirma (hazirlik fisi).
 */
export interface OrderItemSentEventPayload {
  orderId: string;
  items: Array<{
    orderItemId: string;
    productId: string;
    productName: string;
    quantity: number; // milis
  }>;
}

/**
 * Her odeme kaydinda yayinlanir (split odemede birden cok kez). Dinleyiciler:
 * kasa (nakit hareketi), veresiye (method='debt'), yazdirma (fis), stok yok.
 */
export interface OrderPaidEventPayload {
  orderId: string;
  paymentId: string;
  amount: number; // kurus (bu odemenin tutari)
  method: string; // PaymentMethod
  customerId?: string; // veresiye (method='debt') icin
}

/**
 * Bir odeme iade edildiginde (ters kayit) yayinlanir. Dinleyiciler orijinal
 * order.paid etkisini geri alir: kasa (nakit cikisi), veresiye (borc geri alma).
 */
export interface OrderRefundedEventPayload {
  orderId: string;
  paymentId: string; // iade (refund) kaydinin id'si
  originalPaymentId: string; // ters alinan orijinal odeme
  amount: number; // kurus
  method: string; // PaymentMethod
  customerId?: string; // veresiye iadesi icin
}

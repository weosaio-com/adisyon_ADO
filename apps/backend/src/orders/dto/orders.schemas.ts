import { z } from 'zod';
import { OrderStatus, OrderType } from '@ado/shared';

/** Query string 'true'/'false' -> boolean. */
const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

// clientOpId: offline idempotency anahtari (ULID). Istege bagli.
const clientOpId = z.string().min(1).optional();

// --- Adisyon ac ---
export const openOrderSchema = z.object({
  tableId: z.string().nullish(),
  type: z.nativeEnum(OrderType).optional(), // varsayilan: dine_in
  guestCount: z.number().int().positive().optional(),
  note: z.string().nullish(),
  clientOpId,
});
export type OpenOrderDto = z.infer<typeof openOrderSchema>;

// --- Kalem ekle (fiyat/vergi/ad SUNUCUDA snapshot alinir; istemci gondermez) ---
export const addItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(), // milis (x1000)
  note: z.string().nullish(),
  clientOpId,
});
export type AddItemDto = z.infer<typeof addItemSchema>;

// --- Kalem miktar guncelle ---
export const updateItemSchema = z.object({
  quantity: z.number().int().positive(),
});
export type UpdateItemDto = z.infer<typeof updateItemSchema>;

// --- Kalem notu (yalniz gonderilmemis kalem; bos -> not silinir) ---
export const itemNoteSchema = z.object({
  note: z.string().trim().max(200).nullish(),
});
export type ItemNoteDto = z.infer<typeof itemNoteSchema>;

// --- Kalem void / adisyon iptal (gerekce) ---
export const voidItemSchema = z.object({
  reason: z.string().nullish(),
});
export type VoidItemDto = z.infer<typeof voidItemSchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().nullish(),
});
export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;

// --- Masa tasi (baska masaya) ---
export const moveTableSchema = z.object({
  tableId: z.string().min(1),
});
export type MoveTableDto = z.infer<typeof moveTableSchema>;

// --- Adisyon birlestir (kaynak -> hedef) ---
export const mergeOrderSchema = z.object({
  sourceOrderId: z.string().min(1),
});
export type MergeOrderDto = z.infer<typeof mergeOrderSchema>;

// --- Adisyon bol (secili kalemleri yeni adisyona; istege bagli bos masaya) ---
export const splitOrderSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1),
  targetTableId: z.string().min(1).nullish(),
});
export type SplitOrderDto = z.infer<typeof splitOrderSchema>;

// --- Adisyon-seviyesi indirim ---
// percent: value = yuzde (1-100). amount: value = kurus.
export const applyDiscountSchema = z.object({
  type: z.enum(['percent', 'amount']),
  value: z.number().int().positive(),
  reason: z.string().nullish(),
});
export type ApplyDiscountDto = z.infer<typeof applyDiscountSchema>;

// --- Sorgu ---
export const orderQuerySchema = z.object({
  tableId: z.string().optional(),
  status: z.nativeEnum(OrderStatus).optional(),
  type: z.nativeEnum(OrderType).optional(), // dine_in | takeaway | delivery
  open: boolQuery, // true -> yalniz acik adisyonlar
});
export type OrderQueryDto = z.infer<typeof orderQuerySchema>;

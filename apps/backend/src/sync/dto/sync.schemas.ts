import { z } from 'zod';
import { OfflineMutationType } from '@ado/shared';

// clientOpId: istemci uretimi ULID; idempotency anahtari. OFFLINE_DESIGN.md §6
const clientOpId = z.string().min(1);

// Adisyon referansi: sunucu id'si YA DA adisyonu acan OPEN_TABLE mutasyonunun
// clientOpId'si (offline'da sunucu id henuz bilinmez). En az biri zorunlu.
const orderRef = {
  orderId: z.string().min(1).optional(),
  orderClientOpId: z.string().min(1).optional(),
};
const hasOrderRef = (p: { orderId?: string | undefined; orderClientOpId?: string | undefined }) =>
  Boolean(p.orderId || p.orderClientOpId);

// --- POST /sync/mutations ---
export const syncMutationSchema = z.object({
  clientOpId,
  type: z.nativeEnum(OfflineMutationType),
  payload: z.record(z.unknown()).default({}),
  baseVersion: z.number().int().optional(), // bilgi amacli; append-only merge'de zorunlu degil
});
export type SyncMutation = z.infer<typeof syncMutationSchema>;

export const pushMutationsSchema = z.object({
  deviceId: z.string().min(1),
  mutations: z.array(syncMutationSchema).min(1).max(200), // ponytail: 200 ust siniri, tek istek boyutunu sinirlar
});
export type PushMutationsDto = z.infer<typeof pushMutationsSchema>;

// --- Tur bazli payload'lar (dispatch'te dogrulanir; hatali -> rejected INVALID_PAYLOAD) ---
export const openTablePayload = z.object({
  tableId: z.string().min(1).nullish(),
  guestCount: z.number().int().positive().optional(),
  note: z.string().nullish(),
});

export const addLinePayload = z
  .object({
    ...orderRef,
    productId: z.string().min(1),
    quantity: z.number().int().positive(), // milis (x1000)
    note: z.string().nullish(),
    // Garsonun cevrimdisi gordugu birim fiyat (kurus). Sunucudaki fiyat farkliysa kalem
    // sessizce baska fiyatla yazilmaz: Owner onayina (price_changed) alinir. OFF-3
    unitPrice: z.number().int().nonnegative().optional(),
  })
  .refine(hasOrderRef, { message: 'orderId veya orderClientOpId gerekli' });

export const updateLineQtyPayload = z
  .object({
    itemId: z.string().min(1).optional(),
    itemClientOpId: z.string().min(1).optional(),
    quantity: z.number().int().positive(),
  })
  .refine((p) => Boolean(p.itemId || p.itemClientOpId), {
    message: 'itemId veya itemClientOpId gerekli',
  });

export const addNotePayload = z
  .object({
    itemId: z.string().min(1).optional(),
    itemClientOpId: z.string().min(1).optional(),
    note: z.string().min(1),
  })
  .refine((p) => Boolean(p.itemId || p.itemClientOpId), {
    message: 'itemId veya itemClientOpId gerekli',
  });

export const submitOrderPayload = z.object({ ...orderRef }).refine(hasOrderRef, {
  message: 'orderId veya orderClientOpId gerekli',
});

// --- POST /sync/reviews/:id/resolve ---
export const resolveReviewSchema = z.object({
  resolution: z.enum(['yeni_adisyon', 'yeniden_ac', 'reddet']),
  targetTableId: z.string().min(1).nullish(), // yeni_adisyon icin istege bagli masa
});
export type ResolveReviewDto = z.infer<typeof resolveReviewSchema>;

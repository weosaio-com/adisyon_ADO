import { z } from 'zod';
import { smallInt } from '../../payments/money-limits';

/** Query string 'true'/'false' -> boolean. */
const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

// --- Salon (Hall) ---
export const createHallSchema = z.object({
  name: z.string().min(1),
  sortOrder: smallInt('Sıra').optional(),
  isActive: z.boolean().optional(),
});
export const updateHallSchema = createHallSchema.partial();
export type CreateHallDto = z.infer<typeof createHallSchema>;
export type UpdateHallDto = z.infer<typeof updateHallSchema>;

// --- Masa (Table) ---
// Not: `status` bilerek yok. Durum gecisleri (empty/occupied/reserved) siparise
// baglidir -> Siparis modulunde yonetilir. Burada yalnizca tanim + kat plani.
export const createTableSchema = z.object({
  hallId: z.string().min(1),
  name: z.string().min(1),
  seats: z.number().int().positive().max(1000, 'Koltuk sayısı en fazla 1000 olabilir.').optional(),
  posX: smallInt('Konum').nullish(),
  posY: smallInt('Konum').nullish(),
  isActive: z.boolean().optional(),
});
export const updateTableSchema = createTableSchema.partial();
export type CreateTableDto = z.infer<typeof createTableSchema>;
export type UpdateTableDto = z.infer<typeof updateTableSchema>;

export const tableQuerySchema = z.object({
  hallId: z.string().optional(),
  active: boolQuery,
});
export type TableQueryDto = z.infer<typeof tableQuerySchema>;

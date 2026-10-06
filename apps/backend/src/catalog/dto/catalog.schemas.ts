import { z } from 'zod';
import {
  allergenListSchema,
  dietTagListSchema,
  MENU_LIMITS,
  menuTranslationsSchema,
} from '@ado/shared';

/** Query string 'true'/'false' -> boolean. z.coerce.boolean 'false'i true yapar; kullanmiyoruz. */
const boolQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

// --- Kategori ---
export const createCategorySchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullish(),
  sortOrder: z.number().int().optional(),
  color: z.string().nullish(),
  isActive: z.boolean().optional(),
  translations: menuTranslationsSchema.optional(),
});
export const updateCategorySchema = createCategorySchema.partial();
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;

// --- Urun (para: kurus / miktar: milis) ---
export const createProductSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().min(1),
  unitId: z.string().min(1),
  taxId: z.string().min(1),
  brandId: z.string().nullish(),
  barcode: z.string().nullish(),
  sku: z.string().nullish(),
  purchasePrice: z.number().int().nonnegative().optional(),
  salePrice: z.number().int().nonnegative(),
  trackStock: z.boolean().optional(),
  minStock: z.number().int().nonnegative().nullish(),
  isActive: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  // QR menu (@ado/shared menu.ts)
  description: z.string().trim().max(MENU_LIMITS.description).nullish(),
  allergens: allergenListSchema.optional(),
  dietTags: dietTagListSchema.optional(),
  translations: menuTranslationsSchema.optional(),
  isAvailable: z.boolean().optional(),
});
export const updateProductSchema = createProductSchema.partial();
export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;

export const productQuerySchema = z.object({
  favorite: boolQuery,
  active: boolQuery,
  categoryId: z.string().optional(),
  barcode: z.string().optional(),
  search: z.string().optional(),
});
export type ProductQueryDto = z.infer<typeof productQuerySchema>;

export const productAvailabilitySchema = z.object({ isAvailable: z.boolean() });
export type ProductAvailabilityDto = z.infer<typeof productAvailabilitySchema>;

// --- Birim ---
export const createUnitSchema = z.object({
  name: z.string().min(1),
  abbreviation: z.string().nullish(),
});
export const updateUnitSchema = createUnitSchema.partial();
export type CreateUnitDto = z.infer<typeof createUnitSchema>;
export type UpdateUnitDto = z.infer<typeof updateUnitSchema>;

// --- Vergi (oran binde: %10 -> 100) ---
export const createTaxSchema = z.object({
  name: z.string().min(1),
  ratePermille: z.number().int().nonnegative(),
  isDefault: z.boolean().optional(),
});
export const updateTaxSchema = createTaxSchema.partial();
export type CreateTaxDto = z.infer<typeof createTaxSchema>;
export type UpdateTaxDto = z.infer<typeof updateTaxSchema>;

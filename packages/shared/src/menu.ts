/**
 * QR menu sozlesmesi — POS (yayin), bulut (dogrulama) ve qr-web ayni semayi kullanir.
 *
 * Menu sube basina tek bir anlik goruntu (snapshot) olarak tasinir: POS her degisiklikte tumunu
 * yeniden yayinlar, bulut dogrulayip saklar, musteri sayfasi tek istekte okur. Para integer kurus
 * (money.ts). Sabitler ve saf yardimcilar `menu-core.ts`'tedir; bu dosya onlari da disa aktarir.
 *
 * Yalniz `zod`'a baglidir (ulid'e degil): Cloudflare Worker `@ado/shared/menu` giris noktasini
 * kullanir. Dogrulama gerekmeyen tarayici kodu `@ado/shared/menu-core`'u alir (zod yuklenmez).
 */
import { z } from 'zod';
import {
  ALLERGENS,
  BASE_MENU_LANGUAGE,
  DIET_TAGS,
  MENU_IMAGE_KEY_PATTERN,
  MENU_LANGUAGES,
  MENU_LIMITS,
  MENU_SCHEMA_VERSION,
  TABLE_CODE_PATTERN,
  type MenuTranslations,
} from './menu-core.js';

export * from './menu-core.js';

export const menuImageKeySchema = z.string().regex(MENU_IMAGE_KEY_PATTERN);

export const tableCodeSchema = z.string().regex(TABLE_CODE_PATTERN, 'Geçersiz masa kodu');

function dedupe<T>(list: T[]): T[] {
  return Array.from(new Set(list));
}

/** POS'ta ULID; panelde uretilenler de ayni bicimde. */
export const menuIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const menuTextSchema = z.object({
  name: z.string().trim().max(MENU_LIMITS.name).optional(),
  description: z.string().trim().max(MENU_LIMITS.description).optional(),
});

/** Temel dil disindaki ceviriler (tur: menu-core `MenuTranslations`). */
export const menuTranslationsSchema: z.ZodType<MenuTranslations, z.ZodTypeDef, MenuTranslations> =
  z.object({ en: menuTextSchema.optional() });

export const allergenListSchema = z.array(z.enum(ALLERGENS)).max(32).transform(dedupe);
export const dietTagListSchema = z.array(z.enum(DIET_TAGS)).max(32).transform(dedupe);

export const menuCategorySchema = z.object({
  id: menuIdSchema,
  name: z.string().trim().min(1).max(MENU_LIMITS.name),
  sortOrder: z.number().int().default(0),
  translations: menuTranslationsSchema.default({}),
});
export type MenuCategory = z.infer<typeof menuCategorySchema>;

export const menuProductSchema = z.object({
  id: menuIdSchema,
  categoryId: menuIdSchema,
  name: z.string().trim().min(1).max(MENU_LIMITS.name),
  description: z.string().trim().max(MENU_LIMITS.description).default(''),
  /** kurus */
  price: z.number().int().min(0).max(MENU_LIMITS.price),
  imageKey: menuImageKeySchema.nullable().default(null),
  allergens: allergenListSchema.default([]),
  diet: dietTagListSchema.default([]),
  /** false = "Tukendi": listede kalir, siparis verilemez. Pasif urun snapshot'a hic girmez. */
  available: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  translations: menuTranslationsSchema.default({}),
});
export type MenuProduct = z.infer<typeof menuProductSchema>;

export const menuBranchSchema = z.object({
  name: z.string().trim().min(1).max(MENU_LIMITS.branchName),
  address: z.string().trim().max(MENU_LIMITS.address).default(''),
  phone: z.string().trim().max(MENU_LIMITS.phone).default(''),
  /** Musteriye sunulan diller; temel dili icermeli. */
  languages: z
    .array(z.enum(MENU_LANGUAGES))
    .min(1)
    .max(MENU_LANGUAGES.length * 2)
    .transform(dedupe)
    .refine((list) => list.includes(BASE_MENU_LANGUAGE), {
      message: 'Menü dilleri Türkçe içermeli',
    }),
  currency: z.literal('TRY').default('TRY'),
});
export type MenuBranch = z.infer<typeof menuBranchSchema>;

export const menuSnapshotSchema = z
  .object({
    schemaVersion: z.literal(MENU_SCHEMA_VERSION),
    branch: menuBranchSchema,
    categories: z.array(menuCategorySchema).max(MENU_LIMITS.categories),
    products: z.array(menuProductSchema).max(MENU_LIMITS.products),
  })
  .superRefine((menu, ctx) => {
    const categoryIds = new Set<string>();
    menu.categories.forEach((category, i) => {
      if (categoryIds.has(category.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['categories', i, 'id'],
          message: 'Kategori kimliği tekrarlanıyor',
        });
      }
      categoryIds.add(category.id);
    });
    const productIds = new Set<string>();
    menu.products.forEach((product, i) => {
      if (productIds.has(product.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['products', i, 'id'],
          message: 'Ürün kimliği tekrarlanıyor',
        });
      }
      productIds.add(product.id);
      if (!categoryIds.has(product.categoryId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['products', i, 'categoryId'],
          message: 'Ürünün kategorisi menüde yok',
        });
      }
    });
  });
export type MenuSnapshot = z.infer<typeof menuSnapshotSchema>;
/** Varsayilanlari doldurulmamis hali (ör. panelden gelen istek govdesi). */
export type MenuSnapshotInput = z.input<typeof menuSnapshotSchema>;

/** Yayinlanan masa: QR kodu ve musteriye gorunen ad. */
export const menuTableSchema = z.object({
  code: tableCodeSchema,
  name: z.string().trim().min(1).max(MENU_LIMITS.tableName),
  hall: z.string().trim().max(MENU_LIMITS.hallName).default(''),
});
export type MenuTable = z.infer<typeof menuTableSchema>;

export const menuTableListSchema = z
  .array(menuTableSchema)
  .max(MENU_LIMITS.tables)
  .superRefine((tables, ctx) => {
    const codes = new Set<string>();
    tables.forEach((table, i) => {
      if (codes.has(table.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'code'],
          message: 'Masa kodu tekrarlanıyor',
        });
      }
      codes.add(table.code);
    });
  });

/**
 * QR menu sozlesmesi — POS (yayin), bulut (dogrulama) ve qr-web (gosterim) ayni semayi kullanir.
 *
 * Menu sube basina tek bir anlik goruntu (snapshot) olarak tasinir: POS her degisiklikte tumunu
 * yeniden yayinlar, bulut dogrulayip saklar, musteri sayfasi tek istekte okur. Adlar ve
 * aciklamalar temel dilde (tr) yazilir; diger diller `translations` icindedir, eksikse temel
 * metin gosterilir. Para integer kurus (money.ts). Tasarim: QR_MENU_DESIGN.md.
 *
 * Bu dosya yalniz `zod`'a baglidir (ulid'e degil): Cloudflare Worker ve qr-web onu
 * `@ado/shared/menu` giris noktasindan alir.
 */
import { z } from 'zod';

/** Snapshot bicim surumu. Geriye uyumsuz degisiklikte artar; bulut eski surumu okumaya devam eder. */
export const MENU_SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Diller
// -----------------------------------------------------------------------------

/** Menude sunulabilen diller. Yeni dil: buraya + `menuTranslationsSchema`'ya eklenir. */
export const MENU_LANGUAGES = ['tr', 'en'] as const;
export type MenuLanguage = (typeof MENU_LANGUAGES)[number];

/** Temel dil: ad ve aciklamalar bu dilde yazilir. */
export const BASE_MENU_LANGUAGE = 'tr' satisfies MenuLanguage;

// -----------------------------------------------------------------------------
// Alerjen ve diyet etiketleri
// -----------------------------------------------------------------------------

/**
 * Beyani zorunlu 14 alerjen: Turk Gida Kodeksi Gida Etiketleme ve Tuketicileri Bilgilendirme
 * Yonetmeligi Ek-1 (AB 1169/2011 Ek II ile ayni liste).
 */
export const ALLERGENS = [
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'peanuts',
  'soy',
  'milk',
  'nuts',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
  'molluscs',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const ALLERGEN_LABELS: Record<Allergen, Record<MenuLanguage, string>> = {
  gluten: { tr: 'Gluten', en: 'Gluten' },
  crustaceans: { tr: 'Kabuklular', en: 'Crustaceans' },
  eggs: { tr: 'Yumurta', en: 'Eggs' },
  fish: { tr: 'Balık', en: 'Fish' },
  peanuts: { tr: 'Yer fıstığı', en: 'Peanuts' },
  soy: { tr: 'Soya', en: 'Soy' },
  milk: { tr: 'Süt', en: 'Milk' },
  nuts: { tr: 'Sert kabuklu meyveler', en: 'Tree nuts' },
  celery: { tr: 'Kereviz', en: 'Celery' },
  mustard: { tr: 'Hardal', en: 'Mustard' },
  sesame: { tr: 'Susam', en: 'Sesame' },
  sulphites: { tr: 'Sülfitler', en: 'Sulphites' },
  lupin: { tr: 'Acı bakla', en: 'Lupin' },
  molluscs: { tr: 'Yumuşakçalar', en: 'Molluscs' },
};

export const DIET_TAGS = ['vegan', 'vegetarian', 'gluten_free', 'spicy'] as const;
export type DietTag = (typeof DIET_TAGS)[number];

export const DIET_TAG_LABELS: Record<DietTag, Record<MenuLanguage, string>> = {
  vegan: { tr: 'Vegan', en: 'Vegan' },
  vegetarian: { tr: 'Vejetaryen', en: 'Vegetarian' },
  gluten_free: { tr: 'Glutensiz', en: 'Gluten-free' },
  spicy: { tr: 'Acılı', en: 'Spicy' },
};

// -----------------------------------------------------------------------------
// Sinirlar
// -----------------------------------------------------------------------------

/** Snapshot sinirlari. POS menuyu kurarken metinleri bu uzunluklara kirpar. */
export const MENU_LIMITS = {
  name: 120,
  description: 600,
  branchName: 60,
  address: 160,
  phone: 30,
  tableName: 60,
  hallName: 60,
  /** kurus (1.000.000 TL) */
  price: 100_000_000,
  categories: 200,
  products: 2000,
  tables: 500,
} as const;

// -----------------------------------------------------------------------------
// Gorseller
// -----------------------------------------------------------------------------

/** Kabul edilen gorsel turleri (uzanti -> MIME). */
export const MENU_IMAGE_TYPES = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  png: 'image/png',
} as const;
export type MenuImageExt = keyof typeof MENU_IMAGE_TYPES;

/** Tek gorsel ust siniri. Istemci yuklemeden once 800 px WebP'ye kucultur (~50-150 KB). */
export const MENU_IMAGE_MAX_BYTES = 1024 * 1024;

/**
 * Gorsel anahtari = icerigin sha256 ozeti (kucuk harf hex) + uzanti. Icerikten turedigi icin
 * degismez: bulutta ayni gorsel bir kez saklanir ve suresiz onbelleklenir.
 */
export const menuImageKeySchema = z.string().regex(/^[a-f0-9]{64}\.(webp|jpg|png)$/);

export function menuImageKey(sha256Hex: string, ext: MenuImageExt): string {
  return `${sha256Hex.toLowerCase()}.${ext}`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function asciiAt(bytes: Uint8Array, start: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Dosya imzasindan gercek turu bulur (uzantiya/Content-Type'a guvenilmez). */
export function sniffImageType(bytes: Uint8Array): MenuImageExt | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 12 && asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'webp';
  return null;
}

// -----------------------------------------------------------------------------
// Masa kodu
// -----------------------------------------------------------------------------

/** Masa kodu 10 rastgele bayttan (80 bit) uretilir: tahmin edilemez, yenilenebilir. */
export const TABLE_CODE_BYTES = 10;

/** 16 karakter RFC 4648 base32 (A-Z, 2-7). QR'da `.../m/<kod>` olarak yer alir. */
export const tableCodeSchema = z.string().regex(/^[A-Z2-7]{16}$/, 'Geçersiz masa kodu');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Rastgele baytlari masa koduna cevirir. Rastgeleligi cagiran saglar: Node'da
 * `randomBytes(TABLE_CODE_BYTES)`, Worker/tarayicida `crypto.getRandomValues`.
 */
export function encodeTableCode(bytes: Uint8Array): string {
  if (bytes.length !== TABLE_CODE_BYTES) {
    throw new Error(`Masa kodu ${TABLE_CODE_BYTES} bayt ister, ${bytes.length} geldi`);
  }
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET.charAt((buffer >>> bits) & 31);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Snapshot semasi
// -----------------------------------------------------------------------------

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

/** Temel dil disindaki ceviriler. Bos/eksik alan temel metne duser (bkz. `menuText`). */
export const menuTranslationsSchema = z.object({
  en: menuTextSchema.optional(),
});
export type MenuTranslations = z.infer<typeof menuTranslationsSchema>;

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

// -----------------------------------------------------------------------------
// Gosterim yardimcilari
// -----------------------------------------------------------------------------

/** Istenen dildeki ad ve aciklama; ceviri yoksa ya da bossa temel dildeki metin. */
export function menuText(
  item: { name: string; description?: string; translations?: MenuTranslations },
  lang: MenuLanguage,
): { name: string; description: string } {
  const translated = lang === BASE_MENU_LANGUAGE ? undefined : item.translations?.[lang];
  return {
    name: translated?.name?.trim() || item.name,
    description: translated?.description?.trim() || (item.description ?? ''),
  };
}

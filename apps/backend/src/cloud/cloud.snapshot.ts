import {
  MENU_IMAGE_KEY_PATTERN,
  MENU_LIMITS,
  MENU_SCHEMA_VERSION,
  TABLE_CODE_PATTERN,
  type Allergen,
  type DietTag,
  type MenuSnapshot,
  type MenuTable,
  type MenuTranslations,
} from '@ado/shared';

/**
 * POS katalogundan QR menu anlik goruntusu (saf; self-check'li). Pasif kategori ve urunler
 * girmez; "tukendi" urun `available: false` ile girer. Metinler bulut sinirlarina kirpilir ki
 * uzun bir ad tum yayini dusurmesin.
 */
export interface SnapshotInput {
  branch: { name: string; address: string | null; phone: string | null };
  categories: Array<{
    id: string;
    name: string;
    sortOrder: number;
    isActive: boolean;
    translations: MenuTranslations;
  }>;
  products: Array<{
    id: string;
    categoryId: string;
    name: string;
    description: string | null;
    salePrice: number;
    imagePath: string | null;
    allergens: Allergen[];
    dietTags: DietTag[];
    translations: MenuTranslations;
    isActive: boolean;
    isAvailable: boolean;
    sortOrder: number;
  }>;
}

const clip = (text: string | null | undefined, max: number): string =>
  (text ?? '').trim().slice(0, max);

function clipTranslations(translations: MenuTranslations): MenuTranslations {
  const name = clip(translations.en?.name, MENU_LIMITS.name);
  const description = clip(translations.en?.description, MENU_LIMITS.description);
  if (!name && !description) return {};
  return { en: { ...(name ? { name } : {}), ...(description ? { description } : {}) } };
}

const byOrder = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'tr', { numeric: true });

export function buildMenuSnapshot(input: SnapshotInput): MenuSnapshot {
  const categories = input.categories
    .filter((category) => category.isActive && clip(category.name, MENU_LIMITS.name))
    .sort(byOrder)
    .slice(0, MENU_LIMITS.categories)
    .map((category) => ({
      id: category.id,
      name: clip(category.name, MENU_LIMITS.name),
      sortOrder: category.sortOrder,
      translations: clipTranslations(category.translations),
    }));
  // Urunler kategori sirasiyla gruplanir, kategori icinde kendi sirasiyla.
  const categoryIndex = new Map(categories.map((category, index) => [category.id, index]));
  const products = input.products
    .filter(
      (product) =>
        product.isActive &&
        categoryIndex.has(product.categoryId) &&
        clip(product.name, MENU_LIMITS.name),
    )
    .sort(
      (a, b) =>
        (categoryIndex.get(a.categoryId) ?? 0) - (categoryIndex.get(b.categoryId) ?? 0) ||
        byOrder(a, b),
    )
    .slice(0, MENU_LIMITS.products)
    .map((product) => ({
      id: product.id,
      categoryId: product.categoryId,
      name: clip(product.name, MENU_LIMITS.name),
      description: clip(product.description, MENU_LIMITS.description),
      price: product.salePrice,
      imageKey:
        product.imagePath && MENU_IMAGE_KEY_PATTERN.test(product.imagePath)
          ? product.imagePath
          : null,
      allergens: product.allergens,
      diet: product.dietTags,
      available: product.isAvailable,
      sortOrder: product.sortOrder,
      translations: clipTranslations(product.translations),
    }));
  const hasEnglish = [...categories, ...products].some((item) => item.translations.en);
  return {
    schemaVersion: MENU_SCHEMA_VERSION,
    branch: {
      name: clip(input.branch.name, MENU_LIMITS.branchName) || 'İşletme',
      address: clip(input.branch.address, MENU_LIMITS.address),
      phone: clip(input.branch.phone, MENU_LIMITS.phone),
      languages: hasEnglish ? ['tr', 'en'] : ['tr'],
      currency: 'TRY',
    },
    categories,
    products,
  };
}

/** Yayinlanacak masalar: kodu olanlar, salon sirasi ve dogal ad sirasiyla (Masa 2 < Masa 10). */
export function buildTableList(
  tables: Array<{
    publicCode: string | null;
    name: string;
    hall: { name: string; sortOrder: number } | null;
  }>,
): MenuTable[] {
  return tables
    .filter((table) => table.publicCode && TABLE_CODE_PATTERN.test(table.publicCode))
    .sort(
      (a, b) =>
        (a.hall?.sortOrder ?? 0) - (b.hall?.sortOrder ?? 0) ||
        (a.hall?.name ?? '').localeCompare(b.hall?.name ?? '', 'tr') ||
        a.name.localeCompare(b.name, 'tr', { numeric: true }),
    )
    .slice(0, MENU_LIMITS.tables)
    .map((table) => ({
      code: table.publicCode as string,
      name: clip(table.name, MENU_LIMITS.tableName) || 'Masa',
      hall: clip(table.hall?.name, MENU_LIMITS.hallName),
    }));
}

/**
 * Bulut adresini sadelestirir: sema yoksa https eklenir, yol atilir. Yalniz https kabul edilir;
 * gelistirme icin localhost/127.0.0.1 uzerinde http serbesttir.
 */
export function normalizeCloudUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error('Geçersiz bulut adresi.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Bulut adresi https:// ile başlamalı.');
  }
  return url.origin;
}

/** Masadaki QR'in acacagi adres. */
export function qrMenuUrl(cloudUrl: string, code: string): string {
  return `${cloudUrl}/m/${code}`;
}

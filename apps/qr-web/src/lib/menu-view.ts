// Musteri menusunun saf mantigi (self-check'li): dil secimi, arama, filtre, fiyat bicimi.
import {
  ALLERGEN_LABELS,
  BASE_MENU_LANGUAGE,
  DIET_TAG_LABELS,
  menuText,
  type Allergen,
  type DietTag,
  type MenuLanguage,
} from '@ado/shared/menu-core';
import type { MenuCategory, MenuProduct, MenuSnapshot } from '@ado/shared/menu';

/** Musterinin dili: kayitli secim > tarayici dili > temel dil; yalniz menude sunulanlardan. */
export function pickLanguage(
  available: readonly MenuLanguage[],
  preferred: readonly string[],
  saved: string | null,
): MenuLanguage {
  const offered: readonly MenuLanguage[] = available.length ? available : [BASE_MENU_LANGUAGE];
  const isOffered = (code: string): code is MenuLanguage =>
    (offered as readonly string[]).includes(code);
  if (saved && isOffered(saved)) return saved;
  for (const tag of preferred) {
    const code = tag.toLowerCase().split('-')[0] ?? '';
    if (isOffered(code)) return code;
  }
  return offered.includes(BASE_MENU_LANGUAGE) ? BASE_MENU_LANGUAGE : (offered[0] ?? 'tr');
}

/** Aramada buyuk/kucuk harf ve Turkce harf farki yok sayilir: "CORBA" -> "çorba" bulunur. */
export function normalizeSearch(text: string): string {
  return text
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

export interface MenuFilter {
  query: string;
  /** Urun bu etiketlerin hepsini tasimali (ör. yalniz vegan). */
  diet: DietTag[];
  /** Bu alerjenlerden birini iceren urun gizlenir. */
  excludeAllergens: Allergen[];
}
export const EMPTY_FILTER: MenuFilter = { query: '', diet: [], excludeAllergens: [] };

export const activeFilterCount = (filter: MenuFilter): number =>
  filter.diet.length + filter.excludeAllergens.length;

export interface MenuSection {
  category: MenuCategory;
  products: MenuProduct[];
}

const bySortOrder = (a: { sortOrder: number }, b: { sortOrder: number }) =>
  a.sortOrder - b.sortOrder;

/** Kategori sirasiyla bolumler; arama/filtreye uymayan urunler ve bos kategoriler atilir. */
export function menuSections(
  menu: MenuSnapshot,
  lang: MenuLanguage,
  filter: MenuFilter,
): MenuSection[] {
  const query = normalizeSearch(filter.query);
  const matches = (product: MenuProduct): boolean => {
    if (filter.diet.some((tag) => !product.diet.includes(tag))) return false;
    if (filter.excludeAllergens.some((allergen) => product.allergens.includes(allergen))) {
      return false;
    }
    if (!query) return true;
    const local = menuText(product, lang);
    return [local.name, local.description, product.name, product.description].some((text) =>
      normalizeSearch(text).includes(query),
    );
  };
  return [...menu.categories]
    .sort(bySortOrder)
    .map((category) => ({
      category,
      products: menu.products
        .filter((product) => product.categoryId === category.id && matches(product))
        .sort(bySortOrder),
    }))
    .filter((section) => section.products.length > 0);
}

const PRICE = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });

/** kurus -> "₺120,00" (fiyatlar her dilde Turk lirasi bicimiyle). */
export function formatPrice(kurus: number): string {
  return PRICE.format(kurus / 100);
}

export function allergenNames(product: MenuProduct, lang: MenuLanguage): string[] {
  return product.allergens.map((code) => ALLERGEN_LABELS[code][lang]);
}

export function dietNames(product: MenuProduct, lang: MenuLanguage): string[] {
  return product.diet.map((tag) => DIET_TAG_LABELS[tag][lang]);
}

/** "Masa 5 · Bahçe" */
export function tableLabel(table: { name: string; hall: string }): string {
  return table.hall ? `${table.name} · ${table.hall}` : table.name;
}

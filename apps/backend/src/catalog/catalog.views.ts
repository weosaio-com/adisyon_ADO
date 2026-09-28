import {
  ALLERGENS,
  DIET_TAGS,
  menuTranslationsSchema,
  type Allergen,
  type DietTag,
  type MenuTranslations,
} from '@ado/shared';

/**
 * Katalog satirlarinin API gorunumu. QR menu alanlari veritabaninda JSON (TEXT) olarak durur
 * (`*Json` alanlari); API ve sync snapshot'i cozulmus hallerini dondurur. Bozuk ya da bilinmeyen
 * deger istegi dusurmez: gecersiz JSON bos listeye/nesneye, bilinmeyen kod ayiklanir.
 */

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseCodes<T extends string>(text: string, allowed: readonly T[]): T[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) return [];
  const known = value.filter((code): code is T => allowed.includes(code as T));
  return Array.from(new Set(known));
}

export function parseAllergens(text: string): Allergen[] {
  return parseCodes(text, ALLERGENS);
}

export function parseDietTags(text: string): DietTag[] {
  return parseCodes(text, DIET_TAGS);
}

export function parseTranslations(text: string): MenuTranslations {
  const parsed = menuTranslationsSchema.safeParse(parseJson(text));
  return parsed.success ? compactTranslations(parsed.data) : {};
}

/** Bos ceviri alanlarini ve bos dil nesnelerini atar: `{ en: { name: '' } }` -> `{}`. */
export function compactTranslations(translations: MenuTranslations): MenuTranslations {
  const out: MenuTranslations = {};
  for (const [lang, text] of Object.entries(translations) as Array<
    [keyof MenuTranslations, MenuTranslations[keyof MenuTranslations]]
  >) {
    const name = text?.name?.trim();
    const description = text?.description?.trim();
    if (!name && !description) continue;
    out[lang] = { ...(name ? { name } : {}), ...(description ? { description } : {}) };
  }
  return out;
}

type ProductJsonFields = { allergensJson: string; dietTagsJson: string; translationsJson: string };

export type ProductView<T extends ProductJsonFields> = Omit<T, keyof ProductJsonFields> & {
  allergens: Allergen[];
  dietTags: DietTag[];
  translations: MenuTranslations;
};

/** Urun satiri -> API gorunumu (include ile gelen iliskiler korunur). */
export function productView<T extends ProductJsonFields>(row: T): ProductView<T> {
  const { allergensJson, dietTagsJson, translationsJson, ...rest } = row;
  return {
    ...rest,
    allergens: parseAllergens(allergensJson),
    dietTags: parseDietTags(dietTagsJson),
    translations: parseTranslations(translationsJson),
  };
}

export type CategoryView<T extends { translationsJson: string }> = Omit<T, 'translationsJson'> & {
  translations: MenuTranslations;
};

export function categoryView<T extends { translationsJson: string }>(row: T): CategoryView<T> {
  const { translationsJson, ...rest } = row;
  return { ...rest, translations: parseTranslations(translationsJson) };
}

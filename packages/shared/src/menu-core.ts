/**
 * QR menu cekirdegi: sabitler, turler ve saf yardimcilar — hicbir bagimliligi yoktur.
 *
 * Tarayici uygulamalari (POS arayuzu, musteri menusu) etiketleri ve yardimcilari buradan
 * (`@ado/shared/menu-core`) alir; zod semalari `menu.ts`'tedir ve bunlari da disa aktarir.
 * Menu sube basina tek bir anlik goruntu (snapshot) olarak tasinir; adlar ve aciklamalar temel
 * dilde (tr) yazilir, diger diller `translations` icindedir. Tasarim: QR_MENU_DESIGN.md.
 */

/** Snapshot bicim surumu. Geriye uyumsuz degisiklikte artar; bulut eski surumu okumaya devam eder. */
export const MENU_SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Diller
// -----------------------------------------------------------------------------

/** Menude sunulabilen diller. Yeni dil: buraya, `MenuTranslations`'a ve semaya eklenir. */
export const MENU_LANGUAGES = ['tr', 'en'] as const;
export type MenuLanguage = (typeof MENU_LANGUAGES)[number];

/** Temel dil: ad ve aciklamalar bu dilde yazilir. */
export const BASE_MENU_LANGUAGE = 'tr' satisfies MenuLanguage;

export interface MenuText {
  name?: string | undefined;
  description?: string | undefined;
}

/** Temel dil disindaki ceviriler. Bos/eksik alan temel metne duser (bkz. `menuText`). */
export interface MenuTranslations {
  en?: MenuText | undefined;
}

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
export const MENU_IMAGE_KEY_PATTERN = /^[a-f0-9]{64}\.(webp|jpg|png)$/;

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
export const TABLE_CODE_PATTERN = /^[A-Z2-7]{16}$/;

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

// QR menu semasinin runnable self-check'i.
// Calistir: node --experimental-strip-types src/menu.selfcheck.ts
import assert from 'node:assert';
import {
  ALLERGEN_LABELS,
  ALLERGENS,
  DIET_TAG_LABELS,
  DIET_TAGS,
  encodeTableCode,
  MENU_LANGUAGES,
  MENU_LIMITS,
  menuImageKey,
  menuImageKeySchema,
  menuSnapshotSchema,
  menuTableListSchema,
  menuText,
  sniffImageType,
  tableCodeSchema,
  type MenuSnapshotInput,
} from './menu.ts';

const IMG = menuImageKey('A'.repeat(64), 'webp');
assert.equal(IMG, 'a'.repeat(64) + '.webp', 'ozet kucuk harfe cevrilir');

function sample(): MenuSnapshotInput {
  return {
    schemaVersion: 1,
    branch: { name: 'Kebapçı Halil', languages: ['tr', 'en'] },
    categories: [
      { id: 'cat1', name: 'Çorbalar', sortOrder: 1, translations: { en: { name: 'Soups' } } },
      { id: 'cat2', name: 'Tatlılar' },
    ],
    products: [
      {
        id: '01HZX7Y8Z9ABCDEFGHJKMNPQRS',
        categoryId: 'cat1',
        name: 'Mercimek',
        description: 'Günlük',
        price: 12000,
        imageKey: IMG,
        allergens: ['gluten', 'celery', 'gluten'],
        diet: ['vegan'],
        available: false,
        translations: { en: { name: 'Lentil soup', description: '' } },
      },
      { id: 'p2', categoryId: 'cat2', name: 'Künefe', price: 18050 },
    ],
  };
}

// Gecerli menu: varsayilanlar doldurulur, alerjen tekrarlari temizlenir.
const menu = menuSnapshotSchema.parse(sample());
assert.equal(menu.branch.currency, 'TRY');
assert.equal(menu.branch.address, '');
assert.deepEqual(menu.products[0]?.allergens, ['gluten', 'celery']);
assert.equal(menu.products[0]?.imageKey, IMG);
assert.equal(menu.products[0]?.available, false);
const kunefe = menu.products[1];
assert.ok(kunefe);
assert.equal(kunefe.available, true, 'varsayilan: satista');
assert.equal(kunefe.imageKey, null);
assert.equal(kunefe.description, '');
assert.deepEqual(kunefe.translations, {});
assert.deepEqual(menu.categories[1]?.translations, {});

function rejects(mutate: (m: MenuSnapshotInput) => void, pathPart: string): void {
  const input = sample();
  mutate(input);
  const result = menuSnapshotSchema.safeParse(input);
  assert.equal(result.success, false, `reddedilmeliydi: ${pathPart}`);
  const paths = result.error?.issues.map((issue) => issue.path.join('.')) ?? [];
  assert.ok(
    paths.some((p) => p.includes(pathPart)),
    `${pathPart} hatasi bekleniyordu: ${paths.join(', ')}`,
  );
}

// Butunluk: tekrar eden kimlik, olmayan kategori.
rejects((m) => {
  m.products[1]!.id = m.products[0]!.id;
}, 'products.1.id');
rejects((m) => {
  m.categories[1]!.id = 'cat1';
}, 'categories.1.id');
rejects((m) => {
  m.products[1]!.categoryId = 'yok';
}, 'products.1.categoryId');

// Para: tam sayi kurus, negatif ve asiri deger yok.
rejects((m) => {
  m.products[0]!.price = 12.5;
}, 'products.0.price');
rejects((m) => {
  m.products[0]!.price = -1;
}, 'products.0.price');
rejects((m) => {
  m.products[0]!.price = MENU_LIMITS.price + 1;
}, 'products.0.price');

// Etiketler ve metinler.
rejects((m) => {
  Object.assign(m.products[0]!, { allergens: ['nut'] });
}, 'products.0.allergens');
rejects((m) => {
  m.products[0]!.name = '   ';
}, 'products.0.name');
rejects((m) => {
  m.products[0]!.description = 'x'.repeat(MENU_LIMITS.description + 1);
}, 'products.0.description');
rejects((m) => {
  m.branch.languages = ['en'];
}, 'branch.languages');
rejects((m) => {
  Object.assign(m, { schemaVersion: 2 });
}, 'schemaVersion');
rejects((m) => {
  m.products = Array.from({ length: MENU_LIMITS.products + 1 }, (_, i) => ({
    id: `p${i}`,
    categoryId: 'cat1',
    name: 'x',
    price: 1,
  }));
}, 'products');

// Gorsel anahtari: yalniz sha256 hex + izinli uzanti (yol gecisi imkansiz).
assert.ok(menuImageKeySchema.safeParse(IMG).success);
for (const bad of [
  'a'.repeat(64) + '.gif',
  'a'.repeat(63) + '.png',
  'A'.repeat(64) + '.png',
  '../' + 'a'.repeat(61) + '.png',
]) {
  assert.equal(menuImageKeySchema.safeParse(bad).success, false, bad);
}

// Dil: ceviri varsa o, bossa/yoksa temel metin.
const soup = menu.products[0]!;
assert.deepEqual(menuText(soup, 'en'), { name: 'Lentil soup', description: 'Günlük' });
assert.deepEqual(menuText(soup, 'tr'), { name: 'Mercimek', description: 'Günlük' });
assert.deepEqual(menuText(menu.categories[0]!, 'en'), { name: 'Soups', description: '' });
assert.deepEqual(menuText(kunefe, 'en'), { name: 'Künefe', description: '' });

// Her alerjen/diyet etiketi her dilde yazili.
assert.equal(ALLERGENS.length, 14);
for (const code of ALLERGENS) {
  for (const lang of MENU_LANGUAGES) assert.ok(ALLERGEN_LABELS[code][lang], `${code}/${lang}`);
}
for (const tag of DIET_TAGS) {
  for (const lang of MENU_LANGUAGES) assert.ok(DIET_TAG_LABELS[tag][lang], `${tag}/${lang}`);
}

// Masa kodu: RFC 4648 base32, 10 bayt -> 16 karakter.
assert.equal(encodeTableCode(new Uint8Array(10)), 'AAAAAAAAAAAAAAAA');
assert.equal(encodeTableCode(new Uint8Array(10).fill(0xff)), '7777777777777777');
assert.equal(encodeTableCode(new TextEncoder().encode('foobafooba')), 'MZXW6YTBMZXW6YTB');
assert.throws(() => encodeTableCode(new Uint8Array(9)));
const code = encodeTableCode(Uint8Array.from({ length: 10 }, (_, i) => i * 29 + 7));
assert.ok(tableCodeSchema.safeParse(code).success, code);
for (const bad of ['mzxw6ytbmzxw6ytb', 'MZXW6YTBMZXW6YT', 'MZXW6YTBMZXW6YT0', 'MZXW6YTBMZXW6YT1']) {
  assert.equal(tableCodeSchema.safeParse(bad).success, false, bad);
}
const tables = menuTableListSchema.safeParse([
  { code, name: 'Masa 1' },
  { code, name: 'Masa 2', hall: 'Bahçe' },
]);
assert.equal(tables.success, false, 'ayni kod iki masada olamaz');
const oneTable = menuTableListSchema.parse([{ code, name: 'Masa 1' }]);
assert.equal(oneTable[0]?.hall, '');

// Gorsel imzasi: uzantiya degil icerige bakilir.
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): number[] => Array.from(new TextEncoder().encode(text));
assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'jpg');
assert.equal(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'png');
assert.equal(sniffImageType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 '))), 'webp');
assert.equal(sniffImageType(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVEfmt '))), null);
assert.equal(sniffImageType(bytes(...ascii('GIF89a'))), null);
assert.equal(sniffImageType(bytes(0xff, 0xd8)), null);
assert.equal(sniffImageType(new Uint8Array()), null);

console.log('✓ menu self-check OK');

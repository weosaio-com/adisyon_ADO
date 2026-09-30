// Musteri menusu mantiginin runnable self-check'i.
// Calistir: node --experimental-strip-types src/lib/menu-view.selfcheck.ts
import assert from 'node:assert';
import type { MenuSnapshot } from '@ado/shared/menu';
import {
  EMPTY_FILTER,
  activeFilterCount,
  allergenNames,
  dietNames,
  formatPrice,
  menuSections,
  normalizeSearch,
  pickLanguage,
  tableLabel,
} from './menu-view.ts';

// Dil: kayitli secim > tarayici > temel dil; menude olmayan dil secilmez.
assert.equal(pickLanguage(['tr', 'en'], ['en-GB', 'tr'], null), 'en');
assert.equal(pickLanguage(['tr', 'en'], ['de-DE'], null), 'tr');
assert.equal(pickLanguage(['tr'], ['en-US'], null), 'tr', 'EN sunulmuyorsa TR');
assert.equal(pickLanguage(['tr', 'en'], ['en-US'], 'tr'), 'tr', 'kullanicinin secimi oncelikli');
assert.equal(pickLanguage(['tr'], [], 'en'), 'tr', 'artik sunulmayan kayitli dil yok sayilir');

// Arama Turkce harf ve buyuk/kucuk harf farkini yok sayar.
assert.equal(normalizeSearch('ÇORBA'), 'corba');
assert.equal(normalizeSearch('Işık İzmir'), 'isik izmir');
assert.equal(normalizeSearch('  Künefe '), 'kunefe');

const product = (over: Partial<MenuSnapshot['products'][number]>) => ({
  id: 'p',
  categoryId: 'c1',
  name: 'Ürün',
  description: '',
  price: 1000,
  imageKey: null,
  allergens: [],
  diet: [],
  available: true,
  sortOrder: 0,
  translations: {},
  ...over,
});
const menu: MenuSnapshot = {
  schemaVersion: 1,
  branch: { name: 'Lokanta', address: '', phone: '', languages: ['tr', 'en'], currency: 'TRY' },
  categories: [
    { id: 'c2', name: 'Tatlılar', sortOrder: 2, translations: {} },
    { id: 'c1', name: 'Çorbalar', sortOrder: 1, translations: { en: { name: 'Soups' } } },
    { id: 'c3', name: 'Boş', sortOrder: 3, translations: {} },
  ],
  products: [
    product({
      id: 'mercimek',
      name: 'Mercimek',
      description: 'Limonlu',
      sortOrder: 1,
      allergens: ['celery'],
      diet: ['vegan', 'gluten_free'],
      translations: { en: { name: 'Lentil soup' } },
    }),
    product({ id: 'ezogelin', name: 'Ezogelin', allergens: ['gluten'], diet: ['vegan'] }),
    product({ id: 'sutlac', categoryId: 'c2', name: 'Sütlaç', allergens: ['milk'] }),
  ],
};

const ids = (sections: ReturnType<typeof menuSections>) =>
  sections.map((s) => `${s.category.id}:${s.products.map((p) => p.id).join(',')}`);

// Kategori sirasi, urun sirasi; bos kategori gosterilmez.
assert.deepEqual(ids(menuSections(menu, 'tr', EMPTY_FILTER)), [
  'c1:ezogelin,mercimek',
  'c2:sutlac',
]);
// Arama: ceviri de temel metin de aranir.
assert.deepEqual(ids(menuSections(menu, 'en', { ...EMPTY_FILTER, query: 'lentil' })), [
  'c1:mercimek',
]);
assert.deepEqual(ids(menuSections(menu, 'en', { ...EMPTY_FILTER, query: 'MERCIMEK' })), [
  'c1:mercimek',
]);
assert.deepEqual(ids(menuSections(menu, 'tr', { ...EMPTY_FILTER, query: 'sutlac' })), [
  'c2:sutlac',
]);
assert.deepEqual(ids(menuSections(menu, 'tr', { ...EMPTY_FILTER, query: 'limon' })), [
  'c1:mercimek',
]);
assert.deepEqual(menuSections(menu, 'tr', { ...EMPTY_FILTER, query: 'pizza' }), []);
// Diyet: tum secili etiketler; alerjen: iceren gizlenir.
assert.deepEqual(ids(menuSections(menu, 'tr', { ...EMPTY_FILTER, diet: ['vegan'] })), [
  'c1:ezogelin,mercimek',
]);
assert.deepEqual(
  ids(menuSections(menu, 'tr', { ...EMPTY_FILTER, diet: ['vegan', 'gluten_free'] })),
  ['c1:mercimek'],
);
assert.deepEqual(
  ids(menuSections(menu, 'tr', { ...EMPTY_FILTER, excludeAllergens: ['gluten', 'milk'] })),
  ['c1:mercimek'],
);
assert.equal(activeFilterCount({ query: 'x', diet: ['vegan'], excludeAllergens: ['milk'] }), 2);

// Fiyat ve etiketler.
assert.equal(formatPrice(12000), '₺120,00');
assert.equal(formatPrice(1234567), '₺12.345,67');
const mercimek = menu.products[0]!;
assert.deepEqual(allergenNames(mercimek, 'tr'), ['Kereviz']);
assert.deepEqual(allergenNames(mercimek, 'en'), ['Celery']);
assert.deepEqual(dietNames(mercimek, 'tr'), ['Vegan', 'Glutensiz']);
assert.equal(tableLabel({ name: 'Masa 5', hall: 'Bahçe' }), 'Masa 5 · Bahçe');
assert.equal(tableLabel({ name: 'Masa 5', hall: '' }), 'Masa 5');

console.log('✓ menu-view self-check OK');

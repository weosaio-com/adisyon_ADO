// QR menu anlik goruntusu ve bulut adresi yardimcilarinin runnable self-check'i.
// Calistir: ts-node --transpile-only src/cloud/cloud.snapshot.selfcheck.ts
import assert from 'node:assert';
import { menuSnapshotSchema, menuTableListSchema } from '@ado/shared';
import {
  buildMenuSnapshot,
  buildTableList,
  normalizeCloudUrl,
  qrMenuUrl,
  type SnapshotInput,
} from './cloud.snapshot.ts';

const IMG = 'a'.repeat(64) + '.webp';
const product = (over: Partial<SnapshotInput['products'][number]>) => ({
  id: 'p',
  categoryId: 'c1',
  name: 'Ürün',
  description: null,
  salePrice: 1000,
  imagePath: null,
  allergens: [],
  dietTags: [],
  translations: {},
  isActive: true,
  isAvailable: true,
  sortOrder: 0,
  ...over,
});

const snapshot = buildMenuSnapshot({
  branch: { name: '  Kebapçı Halil  ', address: null, phone: '0212 000 00 00' },
  categories: [
    { id: 'c2', name: 'Tatlılar', sortOrder: 2, isActive: true, translations: {} },
    {
      id: 'c1',
      name: 'Çorbalar',
      sortOrder: 1,
      isActive: true,
      translations: { en: { name: 'Soups' } },
    },
    { id: 'c3', name: 'Eski', sortOrder: 0, isActive: false, translations: {} },
  ],
  products: [
    product({ id: 'p10', name: 'Mercimek', sortOrder: 1, imagePath: IMG, allergens: ['gluten'] }),
    product({ id: 'p2', name: 'Ezogelin', sortOrder: 0, isAvailable: false }),
    product({ id: 'p3', name: 'Pasif', isActive: false }),
    product({ id: 'p4', name: 'Eski kategoride', categoryId: 'c3' }),
    product({ id: 'p5', name: 'Bozuk görsel', categoryId: 'c2', imagePath: '../etc/passwd' }),
    product({ id: 'p6', name: 'x'.repeat(500), categoryId: 'c2', description: 'd'.repeat(900) }),
  ],
});

// Bulut semasina uyar (yayin reddedilmez).
assert.ok(menuSnapshotSchema.safeParse(snapshot).success, 'snapshot semaya uymali');
assert.equal(snapshot.branch.name, 'Kebapçı Halil');
assert.deepEqual(snapshot.branch.languages, ['tr', 'en'], 'ceviri varsa EN sunulur');
assert.deepEqual(
  snapshot.categories.map((c) => c.id),
  ['c1', 'c2'],
  'pasif kategori yok, siraya gore',
);
assert.deepEqual(
  snapshot.products.map((p) => p.id),
  ['p2', 'p10', 'p5', 'p6'],
  'pasif urun ve pasif kategorinin urunu yok',
);
const ezogelin = snapshot.products[0]!;
assert.equal(ezogelin.available, false, 'tukendi urun listede, satista degil');
assert.equal(snapshot.products[1]!.imageKey, IMG);
assert.equal(snapshot.products[2]!.imageKey, null, 'gecersiz gorsel anahtari yayinlanmaz');
assert.equal(snapshot.products[3]!.name.length, 120, 'uzun ad kirpilir');
assert.equal(snapshot.products[3]!.description.length, 600);

const trOnly = buildMenuSnapshot({
  branch: { name: '', address: null, phone: null },
  categories: [],
  products: [],
});
assert.deepEqual(trOnly.branch.languages, ['tr']);
assert.equal(trOnly.branch.name, 'İşletme', 'isletme adi bossa yer tutucu');
assert.ok(menuSnapshotSchema.safeParse(trOnly).success);

// Masalar: kodsuzlar atilir, salon ve dogal siraya gore.
const tables = buildTableList([
  { publicCode: 'MASAKODUAAAAAAA3', name: 'Masa 10', hall: { name: 'Salon', sortOrder: 0 } },
  { publicCode: 'MASAKODUAAAAAAA2', name: 'Masa 2', hall: { name: 'Salon', sortOrder: 0 } },
  { publicCode: null, name: 'Kodsuz', hall: null },
  { publicCode: 'MASAKODUAAAAAAA4', name: 'Teras 1', hall: { name: 'Teras', sortOrder: 1 } },
]);
assert.deepEqual(
  tables.map((t) => t.name),
  ['Masa 2', 'Masa 10', 'Teras 1'],
);
assert.equal(tables[0]!.hall, 'Salon');
assert.ok(menuTableListSchema.safeParse(tables).success);

// Bulut adresi: https zorunlu (yerel gelistirme haric), yol atilir.
assert.equal(normalizeCloudUrl('menu.example.com/panel'), 'https://menu.example.com');
assert.equal(normalizeCloudUrl(' https://Menu.Example.com/ '), 'https://menu.example.com');
assert.equal(normalizeCloudUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
assert.throws(() => normalizeCloudUrl('http://menu.example.com'), /https/);
assert.throws(() => normalizeCloudUrl('ftp://x'), /https/);
assert.throws(() => normalizeCloudUrl('http://'), /Geçersiz/);
assert.equal(qrMenuUrl('https://menu.example.com', 'ABCD'), 'https://menu.example.com/m/ABCD');

console.log('cloud.snapshot.selfcheck OK');

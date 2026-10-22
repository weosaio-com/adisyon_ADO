// Turkce dogal siralama self-check'i (URN-1).
// Calistir: ts-node --transpile-only src/tables/natural-order.selfcheck.ts
import assert from 'node:assert';
import { sortNatural } from './natural-order';

const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

// Sayilar sayi olarak: Masa 2 < Masa 10.
assert.deepEqual(
  names(sortNatural(['Masa 10', 'Masa 2', 'Masa 1', 'Masa 11'].map((name) => ({ name })))),
  ['Masa 1', 'Masa 2', 'Masa 10', 'Masa 11'],
);
// Turkce harf sirasi: Ç, C'den sonra; I (ı) S'den once; ı < o.
assert.deepEqual(
  names(
    sortNatural(
      [
        'Tatlılar',
        'Çorbalar',
        'Soğuk İçecekler',
        'Ana Yemekler',
        'Sıcak İçecekler',
        'Izgaralar',
      ].map((name) => ({ name })),
    ),
  ),
  ['Ana Yemekler', 'Çorbalar', 'Izgaralar', 'Sıcak İçecekler', 'Soğuk İçecekler', 'Tatlılar'],
);
// sortOrder once gelir; esitlerde ad.
assert.deepEqual(
  names(
    sortNatural([
      { name: 'Tatlılar', sortOrder: 0 },
      { name: 'Çorbalar', sortOrder: 0 },
      { name: 'Kampanya', sortOrder: -1 },
      { name: 'İçecekler', sortOrder: 5 },
    ]),
  ),
  ['Kampanya', 'Çorbalar', 'Tatlılar', 'İçecekler'],
);

console.log('✓ natural-order self-check OK');

// Para/miktar sinirlari ve 32-bit tasma temizlik gocu self-check'i (SAT-12/13).
// Calistir: ts-node --transpile-only src/payments/money-limits.selfcheck.ts
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_MONEY_KURUS,
  assertMoneyWithinLimit,
  nonNegativeMoneyKurus,
  positiveMoneyKurus,
  quantityMilli,
} from './money-limits';

// 1) Giris sinirlari: 10 milyon TL ve 10.000 adet dahil, ustu Turkce mesajla reddedilir.
assert.ok(positiveMoneyKurus().safeParse(MAX_MONEY_KURUS).success);
const over = positiveMoneyKurus('Satış fiyatı').safeParse(MAX_MONEY_KURUS + 1);
assert.ok(!over.success && over.error.issues[0]!.message.includes('10.000.000 TL'));
assert.ok(!positiveMoneyKurus().safeParse(0).success, 'sifir tutar reddedilir');
assert.ok(nonNegativeMoneyKurus().safeParse(0).success, 'acilis bakiyesi 0 olabilir');
assert.ok(!nonNegativeMoneyKurus().safeParse(-1).success);
assert.ok(!positiveMoneyKurus().safeParse(10.5).success, 'kurus tam sayi');
assert.ok(quantityMilli().safeParse(10_000_000).success);
assert.ok(!quantityMilli().safeParse(10_000_001).success);
assertMoneyWithinLimit(MAX_MONEY_KURUS);
assert.throws(() => assertMoneyWithinLimit(MAX_MONEY_KURUS + 1), /10\.000\.000 TL/);
assert.throws(() => assertMoneyWithinLimit(Number.NaN));

// 2) Temizlik gocu: onceki surumden kalan 32-bit disi deger okunur hale gelir.
const migrationsDir = resolve(__dirname, '../../../../prisma/schema/migrations');
const CLEANUP = '20261022090000_int_overflow_cleanup';
const db = new DatabaseSync(':memory:');

// NOT NULL ve varsayilansiz kolonlari tiplerine gore doldurup tek satir ekler.
function insertRow(table: string, values: Record<string, unknown>): void {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.notnull && c.dflt_value === null) row[c.name] = /TEXT/i.test(c.type) ? 'x' : 0;
  }
  Object.assign(row, values);
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names
      .map(() => '?')
      .join(', ')})`,
  ).run(...(Object.values(row) as Array<string | number | null>));
}

const dirs = readdirSync(migrationsDir)
  .filter((name) => /^\d+_/.test(name))
  .sort();
assert.ok(dirs.includes(CLEANUP), 'temizlik gocu mevcut');
for (const name of dirs) {
  if (name === CLEANUP) {
    db.exec('PRAGMA foreign_keys = OFF'); // ust kayitlar (sube/kategori) bu testte gereksiz
    insertRow('products', {
      id: 'p-bad',
      name: 'Dev fiyat',
      sale_price: 3_000_000_000,
      is_active: 1,
    });
    insertRow('products', { id: 'p-ok', name: 'Kebap', sale_price: 25_000, is_active: 1 });
    insertRow('cash_transactions', { id: 'c-bad', amount: 3_000_000_000, note: 'para girisi' });
    insertRow('cash_transactions', { id: 'c-ok', amount: -5_000 });
    insertRow('tables', { id: 't-bad', name: 'Masa 1', seats: 5_000_000_000, pos_x: 9e12 });
  }
  db.exec(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  if (name === CLEANUP) break;
}
const product = (id: string) =>
  db.prepare('SELECT sale_price, is_active FROM products WHERE id = ?').get(id) as {
    sale_price: number;
    is_active: number;
  };
assert.deepEqual(
  { ...product('p-bad') },
  { sale_price: 0, is_active: 0 },
  'bozuk fiyat temizlendi',
);
assert.deepEqual({ ...product('p-ok') }, { sale_price: 25_000, is_active: 1 }, 'saglam urun aynen');
const txn = (id: string) =>
  db.prepare('SELECT amount, note FROM cash_transactions WHERE id = ?').get(id) as {
    amount: number;
    note: string | null;
  };
assert.equal(txn('c-bad').amount, 0);
assert.ok(txn('c-bad').note!.includes('3000000000') && txn('c-bad').note!.includes('para girisi'));
assert.equal(txn('c-ok').amount, -5_000, 'saglam kasa hareketi aynen');
const table = db.prepare('SELECT seats, pos_x FROM tables WHERE id = ?').get('t-bad') as {
  seats: number;
  pos_x: number | null;
};
assert.deepEqual({ ...table }, { seats: 4, pos_x: null });

console.log('✓ money-limits self-check OK');

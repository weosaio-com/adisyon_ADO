// Tek baglantili Prisma havuzu (SAT-5): `ts-node --transpile-only src/prisma/prisma.service.selfcheck.ts`
import 'reflect-metadata';
import assert from 'node:assert';
import { singleConnectionUrl, TRANSACTION_OPTIONS } from './prisma.service';

// Eksikse eklenir; ? ve & dogru secilir.
assert.strictEqual(singleConnectionUrl('file:./dev.db'), 'file:./dev.db?connection_limit=1');
assert.strictEqual(
  singleConnectionUrl('file:C:/Users/a/AppData/Roaming/Adisyon POS/ado.db'),
  'file:C:/Users/a/AppData/Roaming/Adisyon POS/ado.db?connection_limit=1',
);
assert.strictEqual(
  singleConnectionUrl('file:./dev.db?socket_timeout=10'),
  'file:./dev.db?socket_timeout=10&connection_limit=1',
);
assert.strictEqual(singleConnectionUrl('file:./dev.db?'), 'file:./dev.db?connection_limit=1');
// Bilerek verilmis deger korunur (deneme icin); benzer adli parametre karistirilmaz.
assert.strictEqual(
  singleConnectionUrl('file:./dev.db?connection_limit=3'),
  'file:./dev.db?connection_limit=3',
);
assert.strictEqual(
  singleConnectionUrl('file:./dev.db?max_connection_limit=3'),
  'file:./dev.db?max_connection_limit=3&connection_limit=1',
);

// Islem kuyrukta yogunlugu bekleyebilmeli; sure SQLite busy_timeout'undan (5 sn) uzun olmali.
assert.ok(TRANSACTION_OPTIONS.maxWait >= 5_000);
assert.ok(TRANSACTION_OPTIONS.timeout > 5_000);
assert.ok(TRANSACTION_OPTIONS.timeout < 30_000, 'istemci istek suresinin (30 sn) altinda kalmali');

console.log('✓ prisma.service self-check');

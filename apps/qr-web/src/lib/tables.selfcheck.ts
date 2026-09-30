// Masa yardimcilarinin runnable self-check'i.
// Calistir: node --experimental-strip-types src/lib/tables.selfcheck.ts
import assert from 'node:assert';
import { nextTableName, tableMenuUrl } from './tables.ts';

assert.equal(tableMenuUrl('https://menu.ornek.com', 'ABCD'), 'https://menu.ornek.com/m/ABCD');

assert.equal(nextTableName([]), 'Masa 1');
assert.equal(nextTableName(['Masa 1', 'Masa 2']), 'Masa 3');
assert.equal(nextTableName(['Masa 1', 'Masa 3', 'Masa 4']), 'Masa 5', 'dolu ad atlanir');
assert.equal(nextTableName(['Bahçe 1', 'Bahçe 2']), 'Masa 3');
assert.equal(nextTableName(['MASA 2', ' masa 3 ']), 'Masa 4', 'buyuk/kucuk harf ve bosluk');

console.log('✓ tables self-check OK');

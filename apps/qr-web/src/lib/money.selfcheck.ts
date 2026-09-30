// Panel fiyat girisinin runnable self-check'i.
// Calistir: node --experimental-strip-types src/lib/money.selfcheck.ts
import assert from 'node:assert';
import { parsePrice, priceInput } from './money.ts';

assert.equal(parsePrice('120'), 12000);
assert.equal(parsePrice('120,5'), 12050);
assert.equal(parsePrice('120,50 TL'), 12050);
assert.equal(parsePrice('₺1.250,75'), 125075);
assert.equal(parsePrice('1.250'), 125000, 'nokta binlik ayirac');
assert.equal(parsePrice('12.5'), 1250, 'tek nokta + 1-2 hane ondalik');
assert.equal(parsePrice('0'), 0);
assert.equal(parsePrice(''), null);
assert.equal(parsePrice('abc'), null);
assert.equal(parsePrice('-5'), null);
assert.equal(parsePrice('1,234'), null, 'uc haneli ondalik yok');
assert.equal(priceInput(12050), '120,50');
assert.equal(priceInput(12000), '120');
assert.equal(priceInput(5), '0,05');
assert.equal(parsePrice(priceInput(125075)), 125075);

console.log('✓ money self-check OK');

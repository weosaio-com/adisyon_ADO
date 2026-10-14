// parseTlToKurus'un runnable self-check'i (binlik-nokta bug'i: "1.500" -> 1,50 TL olurdu).
// Calistir: node --experimental-strip-types src/lib/format.selfcheck.ts
import assert from 'node:assert';
import { formatBytes, parseTlToKurus } from './format.ts';

// Duz girisler.
assert.equal(parseTlToKurus('100'), 10000);
assert.equal(parseTlToKurus('12,5'), 1250);
assert.equal(parseTlToKurus('12.5'), 1250);
assert.equal(parseTlToKurus('0,05'), 5);

// Turk binlik formati: nokta binlik, virgul ondalik.
assert.equal(parseTlToKurus('1.500'), 150000);
assert.equal(parseTlToKurus('1.234,56'), 123456);
assert.equal(parseTlToKurus('1.234.567'), 123456700);

// Gecersiz/belirsiz -> NaN (cagiran Number.isFinite ile dogrular).
assert.ok(Number.isNaN(parseTlToKurus('')));
assert.ok(Number.isNaN(parseTlToKurus('abc')));
assert.ok(Number.isNaN(parseTlToKurus('1.5000')));
assert.ok(Number.isNaN(parseTlToKurus('12,345')));

// Boyut: KB yukari yuvarlanir, MB/GB tek ondalik.
assert.equal(formatBytes(0), '0 KB');
assert.equal(formatBytes(1), '1 KB');
assert.equal(formatBytes(1536), '2 KB');
assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
assert.equal(formatBytes(3 * 1024 * 1024 * 1024 + 1), '3.0 GB');

console.log('✓ format.selfcheck OK');

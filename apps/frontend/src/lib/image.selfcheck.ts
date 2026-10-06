// Urun gorseli boyutlandirmasinin runnable self-check'i.
// Calistir: node --experimental-strip-types src/lib/image.selfcheck.ts
import assert from 'node:assert';
import { fitWithin } from './image.ts';

// Uzun kenar 800'e iner, oran korunur.
assert.deepEqual(fitWithin(4000, 3000, 800), { width: 800, height: 600 });
assert.deepEqual(fitWithin(1080, 1920, 800), { width: 450, height: 800 });
// Kucuk gorsel buyutulmez.
assert.deepEqual(fitWithin(640, 480, 800), { width: 640, height: 480 });
// Asiri dar gorselde kenar 0'a dusmez.
assert.deepEqual(fitWithin(8000, 2, 800), { width: 800, height: 1 });
assert.deepEqual(fitWithin(0, 0, 800), { width: 1, height: 1 });

console.log('✓ image self-check OK');

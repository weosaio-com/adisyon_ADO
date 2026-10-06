// Tarayicidaki gorsel anahtarinin bulutla ayni oldugunu dogrular.
// Calistir: node --experimental-strip-types src/lib/image-key.selfcheck.ts
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { imageKeyForBytes } from './image-key.ts';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const webp = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

assert.equal(await imageKeyForBytes(png), `${sha(png)}.png`);
assert.equal(await imageKeyForBytes(webp), `${sha(webp)}.webp`);
assert.equal(await imageKeyForBytes(jpg), `${sha(jpg)}.jpg`);
assert.equal(
  await imageKeyForBytes(new TextEncoder().encode('<svg/>')),
  null,
  'desteklenmeyen tur',
);

console.log('✓ image-key self-check OK');

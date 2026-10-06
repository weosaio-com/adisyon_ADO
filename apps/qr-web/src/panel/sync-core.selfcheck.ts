// Panel yayin kurallarinin runnable self-check'i.
// Calistir: node --experimental-strip-types src/panel/sync-core.selfcheck.ts
import assert from 'node:assert';
import type { MenuSnapshot } from '@ado/shared/menu';
import {
  classifyPublishError,
  referencedImageKeys,
  saveBarState,
  shouldAutoPublish,
} from './sync-core.ts';

const product = (id: string, imageKey: string | null) => ({
  id,
  categoryId: 'c',
  name: id,
  description: '',
  price: 100,
  imageKey,
  allergens: [],
  diet: [],
  available: true,
  sortOrder: 0,
  translations: {},
});
const menu = {
  schemaVersion: 1,
  branch: { name: 'X', address: '', phone: '', languages: ['tr'], currency: 'TRY' },
  categories: [],
  products: [
    product('a', 'k1.webp'),
    product('b', null),
    product('c', 'k1.webp'),
    product('d', 'k2.jpg'),
  ],
} as unknown as MenuSnapshot;
assert.deepEqual(referencedImageKeys(menu), ['k1.webp', 'k2.jpg']);

// Hata turleri: ag yok -> bekle; surum cakismasi ve oturum ayri ele alinir.
assert.equal(classifyPublishError({ status: 0, code: 'NETWORK' }), 'offline');
assert.equal(classifyPublishError({ status: 409, code: 'VERSION_CONFLICT' }), 'conflict');
assert.equal(classifyPublishError({ status: 401, code: 'SESSION_REQUIRED' }), 'session');
assert.equal(classifyPublishError({ status: 409, code: 'IMAGES_MISSING' }), 'images');
assert.equal(classifyPublishError({ status: 400, code: 'VALIDATION_ERROR' }), 'invalid');
assert.equal(classifyPublishError({ status: 500, code: 'ERROR' }), 'other');
assert.equal(classifyPublishError(new Error('x')), 'other');

// Kendiliginden yayin: yalniz istek bekliyorken, cevrimiciyken, cakisma ve devam eden is yokken.
const auto = {
  ready: true,
  hasDraft: true,
  publishPending: true,
  online: true,
  busy: false,
  conflict: false,
};
assert.equal(shouldAutoPublish(auto), true);
assert.equal(shouldAutoPublish({ ...auto, online: false }), false);
assert.equal(shouldAutoPublish({ ...auto, busy: true }), false);
assert.equal(shouldAutoPublish({ ...auto, conflict: true }), false);
assert.equal(shouldAutoPublish({ ...auto, publishPending: false }), false);
assert.equal(shouldAutoPublish({ ...auto, ready: false }), false, 'cihazdaki taslak okunmadan');

// Alt cubuk onceligi: cakisma > yayinlaniyor > bekliyor > hata > degisiklik.
const bar = {
  dirty: true,
  online: true,
  busy: false,
  publishPending: false,
  conflict: false,
  error: false,
};
assert.deepEqual(saveBarState(bar), { kind: 'dirty', online: true });
assert.deepEqual(saveBarState({ ...bar, online: false }), { kind: 'dirty', online: false });
assert.deepEqual(saveBarState({ ...bar, publishPending: true, online: false }), {
  kind: 'queued',
  online: false,
});
assert.deepEqual(saveBarState({ ...bar, busy: true, publishPending: true }), {
  kind: 'publishing',
});
assert.deepEqual(saveBarState({ ...bar, conflict: true, error: true }), { kind: 'conflict' });
assert.deepEqual(saveBarState({ ...bar, error: true }), { kind: 'error', dirty: true });
assert.deepEqual(saveBarState({ ...bar, dirty: false }), { kind: 'hidden' });

console.log('✓ sync-core self-check OK');

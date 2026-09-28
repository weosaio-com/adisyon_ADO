// Katalog API gorunumlerinin (QR menu JSON alanlari) runnable self-check'i.
// Calistir: ts-node --transpile-only src/catalog/catalog.views.selfcheck.ts
import assert from 'node:assert';
import {
  categoryView,
  compactTranslations,
  parseAllergens,
  parseDietTags,
  parseTranslations,
  productView,
} from './catalog.views.ts';

// Gecerli JSON cozulur; bilinmeyen kod ve tekrar ayiklanir (eski/bozuk veri istegi dusurmez).
assert.deepEqual(parseAllergens('["milk","gluten","milk","unknown"]'), ['milk', 'gluten']);
assert.deepEqual(parseAllergens('bozuk'), []);
assert.deepEqual(parseAllergens('{"milk":true}'), []);
assert.deepEqual(parseDietTags('["vegan","spicy"]'), ['vegan', 'spicy']);
assert.deepEqual(parseDietTags(''), []);

assert.deepEqual(parseTranslations('{"en":{"name":"Soup"}}'), { en: { name: 'Soup' } });
assert.deepEqual(parseTranslations('{"en":{"name":"  "}}'), {}, 'bos ceviri atilir');
assert.deepEqual(parseTranslations('[]'), {});
assert.deepEqual(parseTranslations('null'), {});

assert.deepEqual(compactTranslations({ en: { name: ' Soup ', description: '' } }), {
  en: { name: 'Soup' },
});
assert.deepEqual(compactTranslations({ en: {} }), {});

// Gorunum *Json alanlarini cikarir, cozulmus hallerini ekler; diger alanlar (include) korunur.
const view = productView({
  id: 'p1',
  name: 'Mercimek',
  allergensJson: '["celery"]',
  dietTagsJson: '["vegan"]',
  translationsJson: '{"en":{"name":"Lentil soup"}}',
  tax: { ratePermille: 100 },
});
assert.deepEqual(view, {
  id: 'p1',
  name: 'Mercimek',
  tax: { ratePermille: 100 },
  allergens: ['celery'],
  dietTags: ['vegan'],
  translations: { en: { name: 'Lentil soup' } },
});
assert.ok(!('allergensJson' in view));

const category = categoryView({ id: 'c1', name: 'Çorbalar', translationsJson: '{}' });
assert.deepEqual(category, { id: 'c1', name: 'Çorbalar', translations: {} });

console.log('catalog.views.selfcheck OK');

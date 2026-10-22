// Gerekce secimi self-check'i. Calistir: node --experimental-strip-types src/screens/reason.selfcheck.ts
import assert from 'node:assert/strict';
import { OTHER_REASON, REASON_MAX, VOID_REASONS, reasonText } from './reason.ts';

// Secim yoksa gerekce yok: onay dugmesi kapali kalir (sunucu da 400 REASON_REQUIRED doner).
assert.equal(reasonText(null, ''), '');
// Hazir secenek aynen gider (raporda gruplanir); "Diğer" metni kullanilmaz.
assert.equal(reasonText('Zayi', 'yok sayilir'), 'Zayi');
assert.ok(VOID_REASONS.includes('İkram') && VOID_REASONS.includes('Müşteri vazgeçti'));
// "Diğer": metin zorunlu, bosluklar kirpilir.
assert.equal(reasonText(OTHER_REASON, '   '), '');
assert.equal(reasonText(OTHER_REASON, '  Masa dökülmesi '), 'Masa dökülmesi');
// Sunucu siniri: en cok 200 karakter.
assert.equal(reasonText(OTHER_REASON, 'a'.repeat(REASON_MAX)).length, REASON_MAX);
assert.equal(reasonText(OTHER_REASON, 'a'.repeat(REASON_MAX + 1)), '');

console.log('reason self-check OK');

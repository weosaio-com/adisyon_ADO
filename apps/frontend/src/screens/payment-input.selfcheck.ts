// Odeme ekrani hesaplarinin runnable self-check'i.
// Calistir: node --experimental-strip-types src/screens/payment-input.selfcheck.ts
import assert from 'node:assert';
import { cashChange, keyReuser, kurusToInput, netPaid } from './payment-input.ts';

// Iade satiri pozitif tutarla gelir: toplanirsa iadeden sonra "kalan" 0 gorunur, odeme alinamaz.
assert.equal(netPaid([]), 0);
assert.equal(netPaid([{ amount: 5000, direction: 'charge' }, { amount: 9500 }]), 14500);
assert.equal(
  netPaid([
    { amount: 5000, direction: 'charge' },
    { amount: 5000, direction: 'refund' },
    { amount: 9500, direction: 'charge' },
  ]),
  9500,
);

// Hesap 145 TL, musteri 200 TL verdi: satis 145, para ustu 55 (eskiden 200 TL satis yaziliyordu).
assert.equal(cashChange(14500, 20000), 5500);
assert.equal(cashChange(14500, 14500), 0);
assert.equal(cashChange(14500, 0), 0);

assert.equal(kurusToInput(20000), '200');
assert.equal(kurusToInput(14550), '145,50');
assert.equal(kurusToInput(5), '0,05');

// Ayni giris -> ayni anahtar (tekrar basma cift kayit yapmaz); giris degisince yeni anahtar.
let n = 0;
const keyFor = keyReuser(() => `k${++n}`);
const first = keyFor('["cash",14500,20000,"",0]');
assert.equal(keyFor('["cash",14500,20000,"",0]'), first, 'tekrar denemede ayni anahtar');
const other = keyFor('["card",14500,null,"",0]');
assert.notEqual(other, first, 'yontem degisince yeni anahtar');
assert.notEqual(keyFor('["card",14500,null,"",1]'), other, 'basarili odemeden sonra yeni anahtar');

console.log('✓ payment-input self-check OK');

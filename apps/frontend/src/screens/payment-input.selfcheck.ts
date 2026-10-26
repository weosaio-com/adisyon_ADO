// Odeme ekrani hesaplarinin runnable self-check'i.
// Calistir: node --experimental-strip-types src/screens/payment-input.selfcheck.ts
import assert from 'node:assert';
import {
  MAX_MONEY_KURUS,
  cashChange,
  keyReuser,
  kurusToInput,
  moneyLimitError,
  netPaid,
  planPayment,
} from './payment-input.ts';

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

// Sunucu siniri (10.000.000 TL): asan giris sunucuya gitmeden anlasilir hata verir.
assert.equal(moneyLimitError(MAX_MONEY_KURUS), '');
assert.equal(moneyLimitError(0), '');
assert.match(moneyLimitError(MAX_MONEY_KURUS + 1), /10\.000\.000 TL/);
assert.equal(moneyLimitError(Number.NaN), '');

// Sunucunun ayirma kurali: nakitte kalandan fazlasi para ustu; kartla fazla tahsilat yok.
assert.deepEqual(planPayment({ method: 'cash', remaining: 4000, amount: 5000, received: null }), {
  amount: 4000,
  received: 5000,
  change: 1000,
  over: true,
  blocked: false,
});
assert.deepEqual(planPayment({ method: 'cash', remaining: 10000, amount: 6000, received: 10000 }), {
  amount: 6000,
  received: 10000,
  change: 4000,
  over: false,
  blocked: false,
});
assert.deepEqual(planPayment({ method: 'cash', remaining: 10000, amount: 6000, received: null }), {
  amount: 6000,
  change: 0,
  over: false,
  blocked: false,
});
assert.equal(
  planPayment({ method: 'card', remaining: 4000, amount: 5000, received: null }).blocked,
  true,
);
assert.equal(
  planPayment({ method: 'card', remaining: 4000, amount: 4000, received: null }).blocked,
  false,
);

console.log('✓ payment-input self-check OK');

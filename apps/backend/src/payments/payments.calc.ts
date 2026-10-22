import assert from 'node:assert';
import { PaymentMethod } from '@ado/shared';

export interface SettleInput {
  grandTotal: number; // kurus
  alreadyPaid: number; // kurus (onceki charge toplami)
  amount: number; // kurus (bu odemenin adisyona uygulanan tutari)
  method: string; // PaymentMethod
  received?: number; // nakit verilen
}

/**
 * Kalandan fazla girilen tutari dagitir (SAT-2). Nakitte fazlasi para ustudur:
 * adisyona ve kasaya yalniz kalan yazilir, fazlasi alinan nakde (received) gecer.
 * Nakit disinda (kart/havale/QR/veresiye) fazla tahsilat yoktur -> null (reddedilir);
 * aksi halde fazla tutar satis gibi kasaya/rapora girer, Z'de satis != tahsilat olur.
 */
export function allocatePayment(input: {
  remaining: number; // kurus (adisyonun kalan bakiyesi, > 0)
  amount: number; // kurus (girilen tutar)
  method: string; // PaymentMethod
  received?: number; // nakit verilen
}): { amount: number; received?: number } | null {
  const { remaining, amount, method, received } = input;
  if (amount <= remaining) return { amount, ...(received !== undefined ? { received } : {}) };
  if (method !== PaymentMethod.Cash) return null;
  return { amount: remaining, received: Math.max(received ?? amount, amount) };
}

/**
 * Bir odemenin para-ustu + kapanis durumunu hesaplar (saf fonksiyon, para yolu).
 * `amount <= grandTotal - alreadyPaid` cagiran tarafindan dogrulanir.
 * Nakit: received > amount ise para ustu = received - amount; diger yontemlerde 0.
 */
export function settlePayment(input: SettleInput) {
  const { grandTotal, alreadyPaid, amount, method } = input;
  const isCash = method === PaymentMethod.Cash;
  const received = isCash ? (input.received ?? amount) : amount;
  const change = isCash && received > amount ? received - amount : 0;
  const fullyPaid = alreadyPaid + amount >= grandTotal;
  return { received, change, fullyPaid };
}

if (require.main === module) {
  // tam nakit + para ustu
  assert.deepStrictEqual(
    settlePayment({
      grandTotal: 7300,
      alreadyPaid: 0,
      amount: 7300,
      method: 'cash',
      received: 10000,
    }),
    { received: 10000, change: 2700, fullyPaid: true },
  );
  // kismi kart: para ustu yok, kapanmaz
  assert.deepStrictEqual(
    settlePayment({ grandTotal: 10000, alreadyPaid: 0, amount: 4000, method: 'card' }),
    {
      received: 4000,
      change: 0,
      fullyPaid: false,
    },
  );
  // ikinci odeme ile tam kapanis
  assert.deepStrictEqual(
    settlePayment({
      grandTotal: 10000,
      alreadyPaid: 4000,
      amount: 6000,
      method: 'cash',
      received: 6000,
    }),
    { received: 6000, change: 0, fullyPaid: true },
  );
  // nakit received verilmezse amount kadar sayilir
  assert.deepStrictEqual(
    settlePayment({ grandTotal: 5000, alreadyPaid: 0, amount: 5000, method: 'cash' }),
    {
      received: 5000,
      change: 0,
      fullyPaid: true,
    },
  );
  // kartta received gonderilse bile para ustu yok
  assert.deepStrictEqual(
    settlePayment({
      grandTotal: 5000,
      alreadyPaid: 0,
      amount: 5000,
      method: 'card',
      received: 9999,
    }),
    { received: 5000, change: 0, fullyPaid: true },
  );
  // SAT-2: nakitte kalandan fazlasi para ustu olur; adisyona yalniz kalan yazilir.
  const cashOver = allocatePayment({ remaining: 5000, amount: 7000, method: 'cash' });
  assert.deepStrictEqual(cashOver, { amount: 5000, received: 7000 });
  assert.deepStrictEqual(
    settlePayment({ grandTotal: 5000, alreadyPaid: 0, method: 'cash', ...cashOver! }),
    { received: 7000, change: 2000, fullyPaid: true },
  );
  // Alinan nakit girilen tutardan buyukse o esas alinir.
  assert.deepStrictEqual(
    allocatePayment({ remaining: 5000, amount: 7000, method: 'cash', received: 10000 }),
    { amount: 5000, received: 10000 },
  );
  // Kart/havale/veresiyede fazla tahsilat yok.
  assert.strictEqual(allocatePayment({ remaining: 5000, amount: 7000, method: 'card' }), null);
  assert.strictEqual(allocatePayment({ remaining: 5000, amount: 5001, method: 'debt' }), null);
  // Kalan kadar ya da az: oldugu gibi.
  assert.deepStrictEqual(allocatePayment({ remaining: 5000, amount: 5000, method: 'card' }), {
    amount: 5000,
  });
  console.log('payments.calc self-check OK');
}

// Satis ve para spawned e2e (kendi portu 3087): adisyon/odeme/kasa regresyonlari.
// Denetim bulgulari (SAT-*) icin: her bolum bir bulgunun sozlesmesini dogrular.
import { checklist, prepareBackend } from './spawn-backend.mjs';

const t = checklist('Satis ve para (spawned)');
const backend = prepareBackend({ name: 'sales', port: 3087 });
const child = await backend.start();
const { call } = backend;

let seq = 0;
const key = (prefix = 'k') => `${prefix}-${Date.now().toString(36)}-${++seq}`;
const must = (res, label) => {
  if (res.status >= 400) throw new Error(`${label}: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
};
/** Adisyona alinan net odeme (tahsilat - iade). */
const netPaid = async (orderId) =>
  must(await call('GET', `/orders/${orderId}/payments`), 'odemeler').reduce(
    (sum, p) => sum + (p.direction === 'refund' ? -p.amount : p.amount),
    0,
  );
/** Hata zarfindaki kod (basarili yanitta undefined). */
const code = (res) => res.data?.error?.code;
const getOrder = async (orderId) => must(await call('GET', `/orders/${orderId}`), 'adisyon');

try {
  await backend.login();

  // --- Kurulum: katalog (10 TL / 50 TL / 0 TL), salon + masalar, acik kasa ---
  const unit = must(await call('POST', '/units', { name: 'Adet' }), 'birim');
  const cat = must(await call('POST', '/categories', { name: 'Satis' }), 'kategori');
  const tax = must(await call('POST', '/taxes', { name: 'KDV10', ratePermille: 100 }), 'vergi');
  const product = async (name, salePrice) =>
    must(
      await call('POST', '/products', {
        name,
        categoryId: cat.id,
        unitId: unit.id,
        taxId: tax.id,
        salePrice,
      }),
      name,
    );
  const p10 = await product('Ekmek', 1000);
  const p50 = await product('Kebap', 5000);
  const hall = must(await call('POST', '/halls', { name: 'Salon' }), 'salon');
  const tables = [];
  for (let i = 1; i <= 6; i++) {
    tables.push(
      must(await call('POST', '/tables', { hallId: hall.id, name: `Masa ${i}` }), 'masa'),
    );
  }
  must(await call('POST', '/cash/sessions/open', { openingFloat: 10000 }), 'kasa acilisi');

  /** Masasiz (gel-al) adisyon + kalemler. */
  const takeaway = async (...products) => {
    const order = must(await call('POST', '/orders', { type: 'takeaway' }), 'adisyon ac');
    for (const p of products) {
      must(
        await call('POST', `/orders/${order.id}/items`, { productId: p.id, quantity: 1000 }),
        'kalem',
      );
    }
    return getOrder(order.id);
  };

  // --- SAT-4: odeme ile ayni anda eklenen kalem kapanmis adisyonda odenmeden kalmaz ---
  {
    let broken = 0;
    let raced = 0;
    for (let i = 0; i < 10; i++) {
      const order = await takeaway(p50);
      const [pay, add] = await Promise.all([
        call('POST', `/orders/${order.id}/payments`, {
          method: 'card',
          amount: 5000,
          idempotencyKey: key('race'),
        }),
        call('POST', `/orders/${order.id}/items`, { productId: p10.id, quantity: 1000 }),
      ]);
      if (pay.status < 400 && add.status < 400) raced++;
      const after = await getOrder(order.id);
      const paid = await netPaid(order.id);
      if (after.status === 'completed' && after.grandTotal !== paid) broken++;
      if (after.status === 'open') {
        // Kalem once girdiyse kalan tutar acik kalir: tahsil edip kapat.
        must(
          await call('POST', `/orders/${order.id}/payments`, {
            method: 'card',
            amount: after.grandTotal - paid,
            idempotencyKey: key('rest'),
          }),
          'kalan odeme',
        );
      }
      if (add.status >= 400 && !['ORDER_NOT_OPEN', 'ORDER_CHANGED'].includes(code(add))) {
        broken++;
      }
    }
    t.check(
      broken === 0,
      `SAT-4 odeme+kalem yarisinda bozuk adisyon yok (${broken}/10, ${raced} ikisi de gecti)`,
    );
    const closed = await takeaway(p50);
    must(
      await call('POST', `/orders/${closed.id}/payments`, {
        method: 'cash',
        amount: 5000,
        idempotencyKey: key('pay'),
      }),
      'odeme',
    );
    const late = await call('POST', `/orders/${closed.id}/items`, {
      productId: p10.id,
      quantity: 1000,
    });
    t.check(
      late.status === 409 && code(late) === 'ORDER_NOT_OPEN',
      `SAT-4 kapanmis adisyona kalem eklenemez (${late.status} ${code(late)})`,
    );
    t.check(
      (await getOrder(closed.id)).grandTotal === 5000,
      'SAT-4 kapanmis adisyonun toplami degismez',
    );
  }
} finally {
  await backend.stop(child);
}
t.check(child.exitCode === 0, `duzgun kapanir (kod ${child.exitCode})`);
t.done();

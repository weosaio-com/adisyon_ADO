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

  // --- SAT-12/13: buyuk tutar/miktar 422/400 alir, kaydedilmez, listeler bozulmaz ---
  {
    const big = await call('POST', '/products', {
      name: 'Dev fiyat',
      categoryId: cat.id,
      unitId: unit.id,
      taxId: tax.id,
      salePrice: 3_000_000_000,
    });
    t.check(big.status === 422, `SAT-13 21 milyon TL ustu fiyat reddedilir (${big.status})`);
    t.check((await call('GET', '/products')).status === 200, 'SAT-13 urun listesi okunur');
    const cashBig = await call('POST', '/cash/transactions', {
      type: 'income',
      amount: 3_000_000_000,
      method: 'cash',
      note: 'dev tutar',
    });
    t.check(cashBig.status === 422, `SAT-13 dev kasa hareketi reddedilir (${cashBig.status})`);
    t.check(
      (await call('GET', '/cash/sessions/active')).status === 200,
      'SAT-13 kasa ekrani okunur',
    );
    const order = await takeaway(p50);
    const qty = await call('POST', `/orders/${order.id}/items`, {
      productId: p10.id,
      quantity: 3_000_000_000,
    });
    t.check(qty.status === 422, `SAT-12 3 milyon adet reddedilir (${qty.status})`);
    const received = await call('POST', `/orders/${order.id}/payments`, {
      method: 'cash',
      amount: 5000,
      received: 9_999_999_999,
      idempotencyKey: key('big'),
    });
    t.check(received.status === 422, `SAT-12 dev alinan nakit reddedilir (${received.status})`);
    // Tek tek gecerli fiyat x miktar ya da kalemler toplami siniri asarsa yazilmaz.
    const pricey = await product('Pahali', 1_000_000_000);
    const line = await call('POST', `/orders/${order.id}/items`, {
      productId: pricey.id,
      quantity: 2000,
    });
    t.check(
      line.status === 400 && code(line) === 'AMOUNT_LIMIT_EXCEEDED',
      `SAT-12 kalem tutari siniri (${line.status} ${code(line)})`,
    );
    const total = await call('POST', `/orders/${order.id}/items`, {
      productId: pricey.id,
      quantity: 1000,
    });
    t.check(
      total.status === 400 && code(total) === 'AMOUNT_LIMIT_EXCEEDED',
      `SAT-12 adisyon toplami siniri (${total.status} ${code(total)})`,
    );
    t.check((await getOrder(order.id)).grandTotal === 5000, 'SAT-12 adisyon toplami bozulmaz');
    must(await call('POST', `/orders/${order.id}/cancel`, { reason: 'test' }), 'iptal');
  }

  // --- SAT-1/7: toplami 0 olan ya da kalani 0'a dusen adisyon kapanir ---
  {
    const tableStatus = async (id) => must(await call('GET', `/tables/${id}`), 'masa').status;
    // SAT-1: tam indirim (ikram) -> 0 TL; odeme ucu reddeder, "kapat" ucu kapatir.
    const comp = must(await call('POST', '/orders', { tableId: tables[0].id }), 'masa ac');
    must(
      await call('POST', `/orders/${comp.id}/items`, { productId: p50.id, quantity: 1000 }),
      'kalem',
    );
    must(
      await call('POST', `/orders/${comp.id}/discounts`, {
        type: 'percent',
        value: 100,
        reason: 'İkram',
      }),
      'tam indirim',
    );
    const closed = await call('POST', `/orders/${comp.id}/close`);
    t.check(
      closed.status === 201 && closed.data.status === 'completed' && closed.data.isPaid,
      `SAT-1 0 TL adisyon kapanir (${closed.status} ${closed.data.status})`,
    );
    t.check(!!closed.data.completedAt, 'SAT-1 kapanis zamani yazilir');
    t.check((await tableStatus(tables[0].id)) === 'empty', 'SAT-1 masa bosalir');
    const again = await call('POST', `/orders/${comp.id}/close`);
    t.check(
      code(again) === 'ORDER_NOT_OPEN',
      `SAT-1 kapali adisyon tekrar kapanmaz (${code(again)})`,
    );

    const free = await product('Su (ikram)', 0);
    const water = await takeaway(free);
    const waterClosed = await call('POST', `/orders/${water.id}/close`);
    t.check(
      waterClosed.data.status === 'completed',
      `SAT-1 sifir fiyatli urun adisyonu kapanir (${waterClosed.status})`,
    );

    const unpaid = await takeaway(p50);
    const balance = await call('POST', `/orders/${unpaid.id}/close`);
    t.check(
      balance.status === 409 && code(balance) === 'ORDER_HAS_BALANCE',
      `SAT-1 kalan tutarli adisyon kapatilamaz (${balance.status} ${code(balance)})`,
    );
    must(await call('POST', `/orders/${unpaid.id}/cancel`, { reason: 'test' }), 'iptal');
    const empty = must(await call('POST', '/orders', { type: 'takeaway' }), 'bos adisyon');
    const emptyClose = await call('POST', `/orders/${empty.id}/close`);
    t.check(
      code(emptyClose) === 'ORDER_EMPTY',
      `SAT-1 bos adisyon kapat yerine iptal (${code(emptyClose)})`,
    );
    must(await call('POST', `/orders/${empty.id}/discard`), 'bos adisyon kapat');

    // SAT-7: 60 TL, 50 TL kart, 10 TL'lik kalem iptal -> kalan 0, adisyon kendiliginden kapanir.
    const part = must(await call('POST', '/orders', { tableId: tables[1].id }), 'masa ac');
    must(
      await call('POST', `/orders/${part.id}/items`, { productId: p50.id, quantity: 1000 }),
      'kebap',
    );
    const withBread = must(
      await call('POST', `/orders/${part.id}/items`, { productId: p10.id, quantity: 1000 }),
      'ekmek',
    );
    const bread = withBread.items.find((i) => i.productId === p10.id);
    must(await call('POST', `/orders/${part.id}/send-kitchen`), 'mutfaga');
    must(
      await call('POST', `/orders/${part.id}/payments`, {
        method: 'card',
        amount: 5000,
        idempotencyKey: key('part'),
      }),
      'kismi odeme',
    );
    const voided = await call('POST', `/orders/${part.id}/items/${bread.id}/void`, {
      reason: 'Müşteri vazgeçti',
    });
    const afterVoid = await getOrder(part.id);
    t.check(
      voided.status === 201 && afterVoid.status === 'completed' && afterVoid.isPaid,
      `SAT-7 kalan 0 olunca adisyon kapanir (${voided.status} ${afterVoid.status})`,
    );
    t.check((await tableStatus(tables[1].id)) === 'empty', 'SAT-7 masa bosalir');
  }
} finally {
  await backend.stop(child);
}
t.check(child.exitCode === 0, `duzgun kapanir (kod ${child.exitCode})`);
t.done();

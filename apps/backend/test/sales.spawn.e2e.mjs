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
/** Baska kullanicinin belirteciyle istek (garson PIN girisi gibi). */
const callAs = async (token, method, path, body) => {
  const res = await fetch(backend.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data ?? json };
};
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

  // --- SAT-2: fazla odeme satis gibi kasaya girmez ---
  {
    const order = await takeaway(p50);
    const card = await call('POST', `/orders/${order.id}/payments`, {
      method: 'card',
      amount: 7000,
      allowOverpay: true,
      idempotencyKey: key('over'),
    });
    t.check(
      card.status === 400 && code(card) === 'BILL_OVERPAY',
      `SAT-2 kartla kalandan fazla tahsilat reddedilir (${card.status} ${code(card)})`,
    );
    const cash = must(
      await call('POST', `/orders/${order.id}/payments`, {
        method: 'cash',
        amount: 7000,
        allowOverpay: true,
        idempotencyKey: key('over'),
      }),
      'nakit fazla odeme',
    );
    const pay = cash.payments[0];
    t.check(
      cash.status === 'completed' &&
        pay.amount === 5000 &&
        pay.received === 7000 &&
        pay.change === 2000,
      `SAT-2 nakitte fazlasi para ustu (${pay.amount}/${pay.received}/${pay.change})`,
    );
    const session = must(await call('GET', '/cash/sessions/active'), 'kasa');
    const drawer = session.transactions.find((tx) => tx.relatedPaymentId === pay.id);
    t.check(
      drawer?.amount === 5000,
      `SAT-2 kasaya yalniz adisyon tutari girer (${drawer?.amount})`,
    );
  }

  // --- SAT-8: iade + iptal satis sayilmaz; yeniden odemede completedAt son tam odeme ---
  {
    const payCash = async (orderId) =>
      must(
        await call('POST', `/orders/${orderId}/payments`, {
          method: 'cash',
          amount: 5000,
          idempotencyKey: key('pay'),
        }),
        'odeme',
      );
    const refund = async (orderId, paymentId) =>
      must(
        await call('POST', `/orders/${orderId}/payments/${paymentId}/reverse`, {
          reason: 'Yanlış ödeme yöntemi',
          idempotencyKey: key('rev'),
        }),
        'iade',
      );
    const wine = await takeaway(p50);
    const paid = await payCash(wine.id);
    await refund(wine.id, paid.payments[0].id);
    const reopened = await getOrder(wine.id);
    t.check(
      reopened.status === 'open' && reopened.completedAt === null,
      `SAT-8 iade ile acilan adisyonun kapanis zamani silinir (${reopened.status})`,
    );
    must(await call('POST', `/orders/${wine.id}/cancel`, { reason: 'Müşteri iadesi' }), 'iptal');
    const cancelled = await getOrder(wine.id);
    t.check(
      cancelled.status === 'cancelled' && cancelled.completedAt === null,
      'SAT-8 iptal edilen adisyonun completedAt bos',
    );

    const again = await takeaway(p50);
    const firstPay = await payCash(again.id);
    const firstAt = (await getOrder(again.id)).completedAt;
    await refund(again.id, firstPay.payments[0].id);
    await new Promise((r) => setTimeout(r, 20));
    await payCash(again.id);
    const repaid = await getOrder(again.id);
    t.check(
      repaid.status === 'completed' && new Date(repaid.completedAt) > new Date(firstAt),
      'SAT-8 yeniden odenen adisyonda completedAt son tam odeme ani',
    );
  }

  // --- SAT-9: masaya yeni musteri oturduktan sonra onceki odemenin iadesi ---
  {
    const table = tables[2];
    const first = must(await call('POST', '/orders', { tableId: table.id }), 'masa ac');
    must(
      await call('POST', `/orders/${first.id}/items`, { productId: p50.id, quantity: 1000 }),
      'kalem',
    );
    const paid = must(
      await call('POST', `/orders/${first.id}/payments`, {
        method: 'card',
        amount: 5000,
        idempotencyKey: key('pay'),
      }),
      'kart odeme',
    );
    const next = must(await call('POST', '/orders', { tableId: table.id }), 'yeni musteri');
    const rev = await call('POST', `/orders/${first.id}/payments/${paid.payments[0].id}/reverse`, {
      reason: 'Yanlış ödeme yöntemi',
      idempotencyKey: key('rev'),
    });
    const reopened = await getOrder(first.id);
    t.check(rev.status === 201, `SAT-9 iade yapilir (${rev.status} ${code(rev) ?? ''})`);
    t.check(
      reopened.status === 'open' &&
        reopened.tableId === null &&
        reopened.note?.includes(table.name),
      `SAT-9 adisyon masasiz acilir, notta eski masa (${reopened.tableId} / ${reopened.note})`,
    );
    t.check(
      (await getOrder(next.id)).tableId === table.id,
      'SAT-9 yeni musterinin adisyonu masada',
    );
    const fixed = must(
      await call('POST', `/orders/${first.id}/payments`, {
        method: 'cash',
        amount: 5000,
        idempotencyKey: key('pay'),
      }),
      'dogru yontemle odeme',
    );
    t.check(fixed.status === 'completed', 'SAT-9 dogru yontemle yeniden odenir');
    must(await call('POST', `/orders/${next.id}/discard`), 'bos adisyon');
  }

  // --- SAT-10: garson %10 indirim sinirini ust uste ekleyerek asamaz ---
  {
    must(
      await call('POST', '/users', {
        username: 'garson1',
        displayName: 'Garson',
        role: 'waiter',
        pin: '4321',
      }),
      'garson',
    );
    const login = await fetch(`${backend.base}/auth/login-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'garson1', pin: '4321' }),
    }).then((r) => r.json());
    const waiter = login.data.accessToken;
    const order = await takeaway(p50, p50); // 100 TL
    const discount = (value) =>
      callAs(waiter, 'POST', `/orders/${order.id}/discounts`, {
        type: 'percent',
        value,
        reason: 'Müdavim',
      });
    const firstTen = await discount(10);
    const secondTen = await discount(10);
    t.check(firstTen.status === 201, `SAT-10 garson %10 indirim yapar (${firstTen.status})`);
    t.check(
      secondTen.status === 403 && code(secondTen) === 'DISCOUNT_NEEDS_APPROVAL',
      `SAT-10 ikinci %10 toplam sinira takilir (${secondTen.status} ${code(secondTen)})`,
    );
    const after = await getOrder(order.id);
    t.check(
      after.discountTotal === 1000,
      `SAT-10 toplam indirim %10'da kalir (${after.discountTotal})`,
    );
    must(await call('POST', `/orders/${order.id}/cancel`, { reason: 'test' }), 'iptal');
  }

  // --- SAT-6: indirim ve elle kasa hareketinde tekrar korumasi; denetim islem icinde ---
  {
    const order = await takeaway(p50);
    const discountBody = { type: 'amount', value: 500, reason: 'Müdavim', clientOpId: key('dsc') };
    const [d1, d2] = await Promise.all([
      call('POST', `/orders/${order.id}/discounts`, discountBody),
      call('POST', `/orders/${order.id}/discounts`, discountBody),
    ]);
    const d3 = await call('POST', `/orders/${order.id}/discounts`, discountBody);
    const discounted = await getOrder(order.id);
    t.check(
      d1.status === 201 && d2.status === 201 && d3.status === 201,
      `SAT-6 ayni anahtarla indirim tekrari basarili doner (${d1.status}/${d2.status}/${d3.status})`,
    );
    t.check(
      discounted.discounts.length === 1 && discounted.discountTotal === 500,
      `SAT-6 ayni anahtarla tek indirim (${discounted.discounts.length})`,
    );
    const items = must(await call('GET', `/audit?entityType=order_item`), 'denetim');
    t.check(
      discounted.items.every((item) => items.some((a) => a.entityId === item.id)),
      'SAT-6 kalem ekleme denetim kaydinda',
    );
    must(await call('POST', `/orders/${order.id}/cancel`, { reason: 'test' }), 'iptal');

    const cashBody = {
      type: 'income',
      amount: 1500,
      method: 'cash',
      note: 'Bozuk para',
      idempotencyKey: key('cash'),
    };
    const [c1, c2] = await Promise.all([
      call('POST', '/cash/transactions', cashBody),
      call('POST', '/cash/transactions', cashBody),
    ]);
    const session = must(await call('GET', '/cash/sessions/active'), 'kasa');
    const same = session.transactions.filter((tx) => tx.note === 'Bozuk para');
    t.check(
      c1.status === 201 && c2.status === 201 && c1.data.id === c2.data.id && same.length === 1,
      `SAT-6 ayni anahtarla tek kasa hareketi (${c1.status}/${c2.status}, ${same.length})`,
    );
  }

  // --- SAT-11: kasa acilis/kapanis ve para giris/cikisi denetim kaydinda (en sonda: kasa kapanir) ---
  {
    const audit = async (action) => must(await call('GET', `/audit?action=${action}`), 'denetim');
    const opened = await audit('cash.session.open');
    t.check(
      opened.length === 1 && JSON.parse(opened[0].newValue).openingFloat === 10000,
      `SAT-11 kasa acilisi denetimde (${opened.length})`,
    );
    const silent = await call('POST', '/cash/transactions', {
      type: 'payout',
      amount: -2000,
      method: 'cash',
    });
    t.check(
      silent.status === 400 && code(silent) === 'CASH_NOTE_REQUIRED',
      `SAT-11 aciklamasiz para cikisi reddedilir (${silent.status} ${code(silent)})`,
    );
    must(
      await call('POST', '/cash/transactions', {
        type: 'payout',
        amount: -2000,
        method: 'cash',
        note: 'Tüp gaz',
      }),
      'para cikisi',
    );
    const txns = (await audit('cash.txn.create')).filter((a) => a.reason === 'Tüp gaz');
    t.check(
      txns.length === 1 && !!txns[0].userName,
      `SAT-11 para cikisi denetimde, kim ve neden (${txns.length})`,
    );
    const session = must(await call('GET', '/cash/sessions/active'), 'kasa');
    const expected =
      session.openingFloat +
      session.transactions
        .filter((tx) => tx.type !== 'opening' && tx.type !== 'closing')
        .reduce((sum, tx) => sum + tx.amount, 0);
    const closed = await call('POST', '/cash/sessions/close', { countedAmount: expected - 500 });
    t.check(closed.status === 201, `SAT-11 kasa kapanir (${closed.status} ${code(closed) ?? ''})`);
    const closes = await audit('cash.session.close');
    const detail = closes[0] ? JSON.parse(closes[0].newValue) : {};
    t.check(
      closes.length === 1 &&
        detail.expectedAmount === expected &&
        detail.countedAmount === expected - 500 &&
        detail.difference === -500,
      `SAT-11 kapanis denetimde: beklenen/sayilan/fark (${JSON.stringify(detail)})`,
    );
    const chain = must(await call('GET', '/audit/verify'), 'zincir');
    t.check(chain.valid === true, `denetim zinciri gecerli (${chain.count} kayit)`);
  }
} finally {
  await backend.stop(child);
}
t.check(child.exitCode === 0, `duzgun kapanir (kod ${child.exitCode})`);
t.done();

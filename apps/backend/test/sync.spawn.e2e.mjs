// Cevrimdisi senkron e2e (kendi backend'i, port 3091): toplu istek siniri, fiyat farki onayi
// (OFF-3), kasa kapaliyken siparisin tek kararla uygulanmasi ve kok nedenin korunmasi (OFF-2),
// tabletin onay sonucunu ogrenmesi (OFF-8), reddin kalici olmasi, birlesen sipariste yalniz
// kendi kalemlerinin mutfaga gitmesi (OFF-9).
import { monotonicFactory } from 'ulid';
import { checklist, prepareBackend } from './spawn-backend.mjs';

const ulid = monotonicFactory();
const t = checklist('Senkron (spawned)');
const backend = prepareBackend({ name: 'sync', port: 3091 });
const child = await backend.start();
const call = (...args) => backend.call(...args);
const push = (deviceId, mutations) => call('POST', '/sync/mutations', { deviceId, mutations });

try {
  await backend.login();
  await call('POST', '/cash/sessions/open', { openingFloat: 0 });
  const unit = (await call('POST', '/units', { name: 'Adet', abbreviation: 'ad' })).data;
  const tax = (await call('POST', '/taxes', { name: 'KDV10', ratePermille: 100 })).data;
  const cat = (await call('POST', '/categories', { name: 'Içecek' })).data;
  const product = async (name, salePrice) =>
    (
      await call('POST', '/products', {
        name,
        categoryId: cat.id,
        unitId: unit.id,
        taxId: tax.id,
        salePrice,
      })
    ).data;
  const cay = await product('Çay', 1500);
  const ayran = await product('Ayran', 3000);
  const hall = (await call('POST', '/halls', { name: 'Salon' })).data;
  const table = async (name) => (await call('POST', '/tables', { hallId: hall.id, name })).data;
  const [m1, m2, m3, m4] = [
    await table('M1'),
    await table('M2'),
    await table('M3'),
    await table('M4'),
  ];
  const order = async (id) => (await call('GET', `/orders/${id}`)).data;

  // --- Sunucu toplu istek siniri degismedi: istemci 100'luk dilimlerle gonderir (OFF-1).
  const many = Array.from({ length: 201 }, () => ({
    clientOpId: ulid(),
    type: 'SUBMIT_ORDER',
    payload: { orderId: 'yok' },
  }));
  t.check((await push('dev-cap', many)).status === 422, '201 mutasyon tek istekte reddedilir');

  // --- OFF-3: fiyat farki -> onay; onayda guncel fiyatla eklenir ve mutfaga gider.
  const open1 = ulid();
  const r1 = await push('dev-a', [
    { clientOpId: open1, type: 'OPEN_TABLE', payload: { tableId: m1.id } },
    {
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: open1, productId: cay.id, quantity: 1000, unitPrice: 1500 },
    },
    {
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: open1, productId: ayran.id, quantity: 1000, unitPrice: 2000 },
    },
    { clientOpId: ulid(), type: 'SUBMIT_ORDER', payload: { orderClientOpId: open1 } },
  ]);
  const s1 = r1.data.results.map((r) => `${r.status}:${r.reason ?? ''}`);
  t.check(
    s1.join(',') === 'applied:,applied:,conflict:price_changed,applied:',
    `farkli fiyatli kalem onaya alinir, digerleri uygulanir (${s1.join(',')})`,
  );
  const order1 = r1.data.results[0].serverId;
  t.check((await order(order1)).items.length === 1, 'fiyati farkli kalem sessizce yazilmadi');
  let reviews = (await call('GET', '/offline-reviews')).data;
  const priceReview = reviews.find((r) => r.reason === 'price_changed');
  t.check(
    priceReview?.context?.seenPrice === 2000 && priceReview?.context?.currentPrice === 3000,
    'onay kartinda gorulen ve guncel fiyat var',
  );
  const g1 = await call('POST', '/offline-reviews/resolve-group', {
    reviewIds: [priceReview.id],
    resolution: 'uygula',
  });
  const after1 = await order(order1);
  t.check(
    g1.status === 201 &&
      after1.items.length === 2 &&
      after1.items.every((i) => i.status === 'sent'),
    `onaylanan kalem asil adisyona guncel fiyatla eklenir ve mutfaga gider (${g1.status})`,
  );
  t.check(
    after1.items.some((i) => i.productId === ayran.id && i.unitPrice === 3000),
    'onaylanan kalem guncel fiyatla',
  );

  // --- OFF-2: kasa kapaliyken gelen siparis tek grup, kok neden korunur.
  const closed = await call('POST', '/cash/sessions/close', { countedAmount: 0 });
  // Kapanis acik adisyon varken reddedilebilir: once acik adisyonlari kapat.
  if (closed.status !== 201 && closed.status !== 200) {
    for (const o of (await call('GET', '/orders?open=true')).data) {
      await call('POST', `/orders/${o.id}/cancel`, { reason: 'test temizligi' });
    }
    await call('POST', '/cash/sessions/close', { countedAmount: 0 });
  }
  const open2 = ulid();
  const ops2 = [
    { clientOpId: open2, type: 'OPEN_TABLE', payload: { tableId: m2.id } },
    {
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: open2, productId: cay.id, quantity: 2000, unitPrice: 1500 },
    },
    {
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: open2, productId: ayran.id, quantity: 1000, unitPrice: 3000 },
    },
    { clientOpId: ulid(), type: 'SUBMIT_ORDER', payload: { orderClientOpId: open2 } },
  ];
  const r2 = await push('dev-b', ops2);
  const s2 = r2.data.results.map((r) => `${r.status}:${r.reason}`);
  t.check(
    s2.every((s) => s === 'conflict:cash_closed'),
    `bagli kalemler de kasa kapali nedeniyle onayda (eskiden 'masa tasinmis') (${s2.join(',')})`,
  );
  await call('POST', '/cash/sessions/open', { openingFloat: 0 });
  reviews = (await call('GET', '/offline-reviews')).data;
  const group2 = reviews.filter((r) => ops2.some((op) => op.clientOpId === r.clientOpId));
  t.check(
    group2.length === 4 && new Set(group2.map((r) => r.context.groupKey)).size === 1,
    'siparisin dort kaydi tek grup',
  );
  t.check(group2[0]?.context?.tableName === 'M2', 'kartta masa adi');
  const status0 = (await call('POST', '/sync/reviews/status', { clientOpIds: [open2] })).data;
  t.check(status0[0]?.status === 'open', 'tablet onayin beklendigini gorur');
  const g2 = await call('POST', '/offline-reviews/resolve-group', {
    reviewIds: group2.map((r) => r.id),
    resolution: 'uygula',
  });
  const order2 = g2.data.orderId;
  const after2 = order2 ? await order(order2) : null;
  t.check(
    after2?.tableId === m2.id && after2.items.length === 2,
    `tek kararla asil masada tek adisyon, iki kalem (${after2?.tableId === m2.id}, ${after2?.items.length})`,
  );
  t.check(
    after2?.items.every((i) => i.status === 'sent'),
    'mutfaga gonder de uygulandi (kalemler mutfakta)',
  );
  const status2 = (await call('POST', '/sync/reviews/status', { clientOpIds: [open2] })).data;
  t.check(
    status2[0]?.status === 'resolved' && status2[0]?.orderId === order2,
    'tablet onay sonucunu ve adisyonu ogrenir',
  );
  const replay2 = await push('dev-b', ops2.slice(0, 1));
  t.check(
    replay2.data.results[0].status === 'duplicate' && replay2.data.results[0].serverId === order2,
    'tekrar gonderilen masa acma ayni adisyonu dondurur',
  );

  // --- Reddet: kalici; tekrar gonderilirse "reddedildi".
  await call('POST', '/cash/sessions/close', { countedAmount: 0 }).then(async (res) => {
    if (res.status >= 300) {
      for (const o of (await call('GET', '/orders?open=true')).data) {
        await call('POST', `/orders/${o.id}/cancel`, { reason: 'test temizligi' });
      }
      await call('POST', '/cash/sessions/close', { countedAmount: 0 });
    }
  });
  const open3 = ulid();
  const ops3 = [
    { clientOpId: open3, type: 'OPEN_TABLE', payload: { tableId: m3.id } },
    {
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: open3, productId: cay.id, quantity: 1000, unitPrice: 1500 },
    },
  ];
  await push('dev-c', ops3);
  await call('POST', '/cash/sessions/open', { openingFloat: 0 });
  reviews = (await call('GET', '/offline-reviews')).data;
  const group3 = reviews.filter((r) => ops3.some((op) => op.clientOpId === r.clientOpId));
  const g3 = await call('POST', '/offline-reviews/resolve-group', {
    reviewIds: group3.map((r) => r.id),
    resolution: 'reddet',
  });
  const status3 = (await call('POST', '/sync/reviews/status', { clientOpIds: [open3] })).data;
  const replay3 = await push('dev-c', ops3);
  t.check(
    g3.status === 201 &&
      status3[0]?.status === 'rejected' &&
      replay3.data.results.every((r) => r.status === 'rejected'),
    'reddedilen siparis kalici: durum rejected, tekrar gonderim reddedilir',
  );
  t.check(
    (await call('GET', `/orders?tableId=${m3.id}&open=true`)).data.length === 0,
    'reddedilen siparis adisyon acmadi',
  );

  // --- Kok neden reddedildiyse bagli kalem de reddedilir (onaya dusmez).
  const bad = ulid();
  const r4 = await push('dev-d', [
    { clientOpId: bad, type: 'OPEN_TABLE', payload: { tableId: 42 } },
    {
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: bad, productId: cay.id, quantity: 1000 },
    },
  ]);
  const s4 = r4.data.results.map((r) => `${r.status}:${r.reason}`);
  t.check(
    s4.join(',') === 'rejected:INVALID_PAYLOAD,rejected:ORDER_NOT_OPENED',
    `acilamayan adisyonun kalemi reddedilir (${s4.join(',')})`,
  );

  // --- OFF-9: birlesen sipariste yalniz bu tabletin kalemleri mutfaga gider.
  const online = (await call('POST', '/orders', { tableId: m4.id })).data;
  await call('POST', `/orders/${online.id}/items`, { productId: ayran.id, quantity: 1000 });
  const open5 = ulid();
  await push('dev-e', [
    { clientOpId: open5, type: 'OPEN_TABLE', payload: { tableId: m4.id } },
    {
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: open5, productId: cay.id, quantity: 1000, unitPrice: 1500 },
    },
    { clientOpId: ulid(), type: 'SUBMIT_ORDER', payload: { orderClientOpId: open5 } },
  ]);
  const merged = await order(online.id);
  const state = (pid) => merged.items.find((i) => i.productId === pid)?.status;
  t.check(
    state(cay.id) === 'sent' && state(ayran.id) === 'pending',
    `baska garsonun gonderilmemis kalemi mutfaga gitmez (cay=${state(cay.id)}, ayran=${state(ayran.id)})`,
  );
} finally {
  await backend.stop(child);
}
t.done();

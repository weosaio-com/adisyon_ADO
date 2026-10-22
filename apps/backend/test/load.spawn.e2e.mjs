// Yuk testi (SAT-5, kendi portu 3081): ayni anda yazan cihazlar takilmamali ve hata almamali.
// Eskiden Prisma'nin coklu baglanti havuzu SQLite dosya kilidinde dusuyordu: 6 tablet ayni anda
// kalem ekleyince isteklerin %78'i 5 sn bekleyip 503/500 donuyordu. Tek baglantida istekler kuyrukta
// sirayla calisir. Kontroller:
//  1. 12 cihaz ayni anda kalem ekler (5 tur): hata 0, en uzun istek sinirli, her basari kayitli.
//  2. Baska bir surec veritabanini 2,5 sn kilitlerken 8 cihaz yazar: istekler kilidi bekler, hata 0
//     (islem baglanti beklemesi maxWait bu kilitten uzun olmali).
//  3. Kilit beklenebilecek sureden uzun (11 sn) surerse: hata 500 degil 503 DB_BUSY (GUV-7; istemci
//     oturumu kapatmadan tekrar dener), istek sinirli surede doner, kilit kalkinca yazma calisir.
import { DatabaseSync } from 'node:sqlite';
import { checklist, prepareBackend } from './spawn-backend.mjs';

const WRITERS = 12;
const ROUNDS = 5;
// Yerelde ~0,3 sn; yavas CI makinesine pay. Eski davranista istekler 5-10 sn takiliyordu.
const BURST_MAX_MS = 2_500;
const LOCK_MS = 2_500;
const LOCK_WRITERS = 8;
const LONG_LOCK_MS = 11_000;

const t = checklist('Yuk testi: eszamanli yazarlar (spawned)');
const backend = prepareBackend({ name: 'load', port: 3081 });
const child = await backend.start();

async function must(method, path, body) {
  const res = await backend.call(method, path, body);
  if (res.status >= 400)
    throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

/** Hepsi ayni anda: her istegin durumu ve suresi. */
async function burst(orderIds, productId) {
  return Promise.all(
    orderIds.map(async (orderId) => {
      const started = Date.now();
      const res = await backend.call('POST', `/orders/${orderId}/items`, {
        productId,
        quantity: 1000,
      });
      return { status: res.status, code: res.data?.error?.code, ms: Date.now() - started };
    }),
  );
}

/** Baska bir surec gibi yazma kilidini `ms` boyunca tutar (BEGIN IMMEDIATE), bu sirada fn calisir. */
async function withExternalLock(dbPath, ms, fn) {
  const holder = new DatabaseSync(dbPath);
  let holding = true;
  const unlock = () => {
    if (!holding) return;
    holding = false;
    holder.exec('ROLLBACK');
  };
  holder.exec('BEGIN IMMEDIATE');
  const release = setTimeout(unlock, ms);
  try {
    return await fn();
  } finally {
    clearTimeout(release);
    unlock();
    holder.close();
  }
}

function summary(results) {
  const failed = results.filter((r) => r.status >= 300);
  const codes = {};
  for (const r of failed)
    codes[`${r.status}:${r.code}`] = (codes[`${r.status}:${r.code}`] ?? 0) + 1;
  return {
    ok: results.length - failed.length,
    failed: failed.length,
    codes,
    maxMs: Math.max(...results.map((r) => r.ms)),
  };
}

try {
  await backend.login();
  const unit = await must('POST', '/units', { name: 'Adet', abbreviation: 'ad' });
  const category = await must('POST', '/categories', { name: 'Yuk' });
  const tax = await must('POST', '/taxes', { name: 'KDV10', ratePermille: 100 });
  const product = await must('POST', '/products', {
    name: 'Ekmek',
    categoryId: category.id,
    unitId: unit.id,
    taxId: tax.id,
    salePrice: 1000,
  });
  const hall = await must('POST', '/halls', { name: 'Salon' });
  await must('POST', '/cash/sessions/open', { openingFloat: 0 });
  const orderIds = [];
  for (let i = 1; i <= WRITERS; i++) {
    const table = await must('POST', '/tables', { hallId: hall.id, name: `M${i}` });
    orderIds.push((await must('POST', '/orders', { tableId: table.id })).id);
  }

  // 1. Ani yogunluk: 12 cihaz ayni anda, 5 tur.
  const results = [];
  for (let round = 0; round < ROUNDS; round++) results.push(...(await burst(orderIds, product.id)));
  const burstSummary = summary(results);
  console.log(`  ${WRITERS} yazar x ${ROUNDS} tur: ${JSON.stringify(burstSummary)}`);
  t.check(burstSummary.failed === 0, `${WRITERS} eszamanli yazarda hata yok`);
  t.check(
    burstSummary.maxMs < BURST_MAX_MS,
    `en uzun istek ${burstSummary.maxMs} ms (< ${BURST_MAX_MS})`,
  );
  let saved = 0;
  for (const orderId of orderIds) saved += (await must('GET', `/orders/${orderId}`)).items.length;
  t.check(saved === burstSummary.ok, `her basarili istek kayitli (${saved}/${burstSummary.ok})`);

  // 2. Baska bir surec (yedek araci, antivirus vb.) yazma kilidini kisa sure tutarken.
  const dbPath = backend.env.DATABASE_URL.slice('file:'.length);
  const locked = summary(
    await withExternalLock(dbPath, LOCK_MS, () =>
      burst(orderIds.slice(0, LOCK_WRITERS), product.id),
    ),
  );
  console.log(`  ${LOCK_MS} ms kilit altinda ${LOCK_WRITERS} yazar: ${JSON.stringify(locked)}`);
  t.check(locked.failed === 0, 'kisa kilit beklenir, hata donmez');
  t.check(locked.maxMs >= LOCK_MS - 200, `istekler kilidi bekledi (${locked.maxMs} ms)`);
  t.check(locked.maxMs < LOCK_MS + 5_000, 'kilit kalkinca hemen tamamlanir');

  // 3. Uzun kilit: beklenebilecek sureyi asan istekler gecici hata (503 DB_BUSY) alir, 500 degil.
  //    Bu sirada canlilik ucu (masaustu bekcisi, PLT-12) veritabanini beklemeden yanit verir.
  let live = { status: 0, ms: 0 };
  const long = summary(
    await withExternalLock(dbPath, LONG_LOCK_MS, async () => {
      const writes = burst(orderIds.slice(0, 4), product.id);
      await new Promise((resolve) => setTimeout(resolve, 500)); // yazmalar kuyrukta beklerken
      const started = Date.now();
      const res = await fetch(`${backend.base}/health/live`);
      live = { status: res.status, ms: Date.now() - started };
      return writes;
    }),
  );
  t.check(
    live.status === 200 && live.ms < 1_000,
    `kilitliyken canlilik ucu hemen yanit verir (${live.ms} ms)`,
  );
  console.log(`  ${LONG_LOCK_MS} ms kilit altinda 4 yazar: ${JSON.stringify(long)}`);
  const busyOnly = Object.keys(long.codes).every((code) => code === '503:DB_BUSY');
  t.check(busyOnly, `uzun kilitte hatalar yalniz 503 DB_BUSY (${JSON.stringify(long.codes)})`);
  t.check(long.maxMs < 20_000, `istek sinirli surede doner (${long.maxMs} ms)`);
  const after = await backend.call('POST', `/orders/${orderIds[0]}/items`, {
    productId: product.id,
    quantity: 1000,
  });
  t.check(
    after.status === 201 || after.status === 200,
    `kilit kalkinca yazma calisir (${after.status})`,
  );
} finally {
  await backend.stop(child);
}
t.done();

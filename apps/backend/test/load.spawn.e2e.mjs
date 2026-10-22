// Yuk testi (SAT-5, kendi portu 3081): ayni anda yazan cihazlar takilmamali ve hata almamali.
// Eskiden Prisma'nin coklu baglanti havuzu SQLite dosya kilidinde dusuyordu: 6 tablet ayni anda
// kalem ekleyince isteklerin %78'i 5 sn bekleyip 503/500 donuyordu. Tek baglantida istekler kuyrukta
// sirayla calisir. Kontroller:
//  1. 12 cihaz ayni anda kalem ekler (5 tur): hata 0, en uzun istek sinirli, her basari kayitli.
//  2. Baska bir surec veritabanini 2,5 sn kilitlerken 8 cihaz yazar: istekler kilidi bekler, hata 0
//     (islem baglanti beklemesi maxWait bu kilitten uzun olmali).
import { DatabaseSync } from 'node:sqlite';
import { checklist, prepareBackend } from './spawn-backend.mjs';

const WRITERS = 12;
const ROUNDS = 5;
// Yerelde ~0,3 sn; yavas CI makinesine pay. Eski davranista istekler 5-10 sn takiliyordu.
const BURST_MAX_MS = 2_500;
const LOCK_MS = 2_500;
const LOCK_WRITERS = 8;

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
  const holder = new DatabaseSync(dbPath);
  let holding = true;
  const unlock = () => {
    if (!holding) return;
    holding = false;
    holder.exec('ROLLBACK');
  };
  holder.exec('BEGIN IMMEDIATE');
  const release = setTimeout(unlock, LOCK_MS);
  const locked = summary(await burst(orderIds.slice(0, LOCK_WRITERS), product.id));
  clearTimeout(release);
  unlock();
  holder.close();
  console.log(`  ${LOCK_MS} ms kilit altinda ${LOCK_WRITERS} yazar: ${JSON.stringify(locked)}`);
  t.check(locked.failed === 0, 'kisa kilit beklenir, hata donmez');
  t.check(locked.maxMs >= LOCK_MS - 200, `istekler kilidi bekledi (${locked.maxMs} ms)`);
  t.check(locked.maxMs < LOCK_MS + 5_000, 'kilit kalkinca hemen tamamlanir');
} finally {
  await backend.stop(child);
}
t.done();

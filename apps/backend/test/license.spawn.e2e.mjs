// Lisans politikasi spawned e2e (kendi portu 3041): zorunluluk ACIK, kendi test anahtar cifti.
// Kontroller: lisanssiz yeni adisyon 403 LICENSE_LOCKED (kurulum, katalog, ayar, yedek, rapor
// calisir); gecerli lisansla adisyon acilir; ek suresi bitmis lisansta acik adisyon odenip kapanir
// ama yeni adisyon acilmaz; senkron OPEN_TABLE kayitli "rejected" olur (toplu istek 403 degil);
// kilitten once olusmus cevrimdisi islem gecer; inceleme kuyrugundan "yeni adisyon" da durur;
// yenileme kilidi hemen kaldirir; saat geri alinsa da (isaret ileride) kilit kalir.
// Buluttan gelen license.remote yenilemesi icin test kancasi yok: license.service.selfcheck.ts.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import { buildPayload, generateLicenseKeyPair, signLicense } from '../../../scripts/license.mjs';
import { checklist, prepareBackend } from './spawn-backend.mjs';

const SUPPORT = '0850 000 00 00';
const LICENSE_ID = 'lic_e2e_policy01';
const DAY_MS = 86_400_000;
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
};

const t = checklist('Lisans politikasi (spawned, zorunluluk acik)');
const { privateKeyPem, publicKeyB64 } = generateLicenseKeyPair();
const license = (exp, extra = {}) =>
  signLicense(
    buildPayload({ id: LICENSE_ID, customer: 'E2E Lokanta', exp: ymd(exp), ...extra }),
    privateKeyPem,
  );
const locked = (res) => res.status === 403 && res.data.error?.code === 'LICENSE_LOCKED';

const backend = prepareBackend({
  name: 'license',
  port: 3041,
  env: {
    ADO_LICENSE_ENFORCE: '1',
    ADO_LICENSE_PUBLIC_KEY: publicKeyB64,
    ADO_TRIAL_DAYS: '0',
    ADO_GRACE_DAYS: '7',
    ADO_SUPPORT_CONTACT: SUPPORT,
    CLOUD_API_URL: '',
  },
});
const child = await backend.start();
const db = new DatabaseSync(join(backend.dataDir, 'license.db'));
db.exec('PRAGMA busy_timeout = 5000');
try {
  await backend.login();
  const { call } = backend;

  // --- Lisans yok: kurulum isleri serbest, satis yok ---
  const unit = await call('POST', '/units', { name: 'Adet', abbreviation: 'ad' });
  const category = await call('POST', '/categories', { name: 'Yemek' });
  const tax = await call('POST', '/taxes', { name: 'KDV10', ratePermille: 100 });
  const product = await call('POST', '/products', {
    name: 'Kofte',
    categoryId: category.data.id,
    unitId: unit.data.id,
    taxId: tax.data.id,
    salePrice: 10000,
  });
  const hall = await call('POST', '/halls', { name: 'Salon' });
  const tables = [];
  for (const name of ['M1', 'M2', 'M3', 'M4']) {
    tables.push((await call('POST', '/tables', { hallId: hall.data.id, name })).data);
  }
  const cash = await call('POST', '/cash/sessions/open', { openingFloat: 0 });
  t.check(
    [unit, category, tax, product, hall, cash].every((r) => r.status < 400) &&
      tables.every((table) => table?.id),
    'lisanssiz: menu, salon/masa ve kasa kurulumu serbest',
  );

  const none = (await call('GET', '/license')).data;
  t.check(
    none.phase === 'unlicensed' &&
      none.locked === true &&
      none.enforced === true &&
      none.reason === 'no_license' &&
      none.supportContact === SUPPORT &&
      none.banner?.level === 'danger',
    `lisans yok: kilitli, destek iletisimi var (${none.phase})`,
  );
  const noLicenseOrder = await call('POST', '/orders', { tableId: tables[0].id });
  t.check(
    locked(noLicenseOrder),
    `lisans yok: POST /orders 403 LICENSE_LOCKED (${noLicenseOrder.status})`,
  );
  t.check(
    /Lisans tanımlı değil/.test(noLicenseOrder.data.error?.message ?? '') &&
      noLicenseOrder.data.error.message.includes(SUPPORT),
    'kilit mesaji Turkce ve destek iletisimini icerir',
  );
  const reads = await Promise.all(
    [
      '/categories',
      '/products',
      '/settings',
      '/settings/business',
      '/backups',
      '/reports/sales/daily',
      '/reports/end-of-day',
      '/cash/status',
      '/tables',
    ].map((path) => call('GET', path)),
  );
  t.check(
    reads.every((r) => r.status === 200),
    `lisans yok: katalog/ayar/yedek/rapor okunur (${reads.map((r) => r.status).join(',')})`,
  );
  const backup = await call('POST', '/backups');
  t.check(backup.status < 400, `lisans yok: yedek alinir (${backup.status})`);

  // --- Gecerli lisans: kilit hemen kalkar ---
  const activated = await call('POST', '/license/activate', {
    licenseKey: license(addDays(new Date(), 365)),
  });
  t.check(
    activated.status < 400 && activated.data.phase === 'active' && activated.data.locked === false,
    `gecerli lisans etkinlesti, kilit kalkti (${activated.status} ${activated.data.phase})`,
  );
  const openOrder = await call('POST', '/orders', { tableId: tables[0].id });
  t.check(
    openOrder.status < 400 && openOrder.data.id,
    `gecerli lisans: adisyon acildi (${openOrder.status})`,
  );
  const item = await call('POST', `/orders/${openOrder.data.id}/items`, {
    productId: product.data.id,
    quantity: 1000,
  });
  t.check(item.status < 400 && item.data.grandTotal === 10000, 'adisyona kalem eklendi');

  // --- Ek suresi bitmis lisans (zaman gecmis gibi): exp bugun, g=0 -> kilit bugun 00:00 ---
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  db.prepare('UPDATE license_info SET license_key = ? WHERE deleted_at IS NULL').run(
    license(today, { grace: 0 }),
  );
  const expired = (await call('GET', '/license')).data;
  const lockAt = Date.parse(expired.lockAt ?? '');
  t.check(
    expired.phase === 'locked' && expired.locked === true && expired.reason === 'expired',
    `ek suresi bitmis lisans: kilitli (${expired.phase})`,
  );
  t.check(lockAt === today.getTime(), 'kilit ani: bitis gunu basi (g=0)');

  const paid = await call('POST', `/orders/${openOrder.data.id}/payments`, {
    method: 'cash',
    amount: 10000,
    idempotencyKey: ulid(),
  });
  t.check(
    paid.status < 400 && paid.data.status === 'completed',
    `kilitliyken acik adisyon odenip kapanir (${paid.status} ${paid.data.status})`,
  );
  const newOrder = await call('POST', '/orders', { tableId: tables[1].id });
  t.check(locked(newOrder), `kilitliyken yeni adisyon 403 (${newOrder.status})`);
  const takeaway = await call('POST', '/orders', { type: 'takeaway' });
  t.check(locked(takeaway), `kilitliyken gel-al adisyonu da 403 (${takeaway.status})`);
  const setupWrites = [
    await call('POST', '/categories', { name: 'Tatli' }),
    await call('PUT', '/settings/business', { name: 'E2E Lokanta' }),
    await call('POST', '/tables', { hallId: hall.data.id, name: 'M5' }),
  ];
  t.check(
    setupWrites.every((r) => r.status < 400),
    `kilitliyken katalog/ayar/masa yazilir (${setupWrites.map((r) => r.status).join(',')})`,
  );
  const report = await call('GET', '/reports/sales/daily');
  t.check(report.status === 200, 'kilitliyken rapor okunur');

  // --- Senkron OPEN_TABLE: toplu istek basarili, mutasyon kayitli "rejected" ---
  const syncOp = ulid();
  const sync = await call('POST', '/sync/mutations', {
    deviceId: 'dev-e2e-license',
    mutations: [{ clientOpId: syncOp, type: 'OPEN_TABLE', payload: { tableId: tables[1].id } }],
  });
  const syncResult = sync.data.results?.[0];
  t.check(
    sync.status < 300 &&
      syncResult?.status === 'rejected' &&
      syncResult.reason === 'LICENSE_LOCKED',
    `senkron OPEN_TABLE rejected LICENSE_LOCKED, istek ${sync.status} (${JSON.stringify(syncResult)})`,
  );
  const replay = await call('POST', '/sync/mutations', {
    deviceId: 'dev-e2e-license',
    mutations: [{ clientOpId: syncOp, type: 'OPEN_TABLE', payload: { tableId: tables[1].id } }],
  });
  t.check(
    replay.data.results?.[0]?.status === 'rejected',
    'tekrar gonderim defterden ayni sonucu alir (outbox takilmaz)',
  );

  // Kilitten once tablette (cevrimdisi) acilmis masa gecer: ULID zamani < kilit ani.
  const beforeLock = lockAt - 60_000;
  if (Date.now() - beforeLock < DAY_MS - 60_000) {
    const offline = await call('POST', '/sync/mutations', {
      deviceId: 'dev-e2e-license',
      mutations: [
        { clientOpId: ulid(beforeLock), type: 'OPEN_TABLE', payload: { tableId: tables[2].id } },
      ],
    });
    t.check(
      offline.data.results?.[0]?.status === 'applied',
      `kilitten once olusmus cevrimdisi OPEN_TABLE uygulanir (${JSON.stringify(offline.data.results?.[0])})`,
    );
  } else {
    console.log('  - gun sonuna 1 dk kaldi: kilitten once cevrimdisi islem kontrolu atlandi');
  }

  // Inceleme kuyrugundan "yeni adisyon" da yeni adisyondur: kilitliyken 403, inceleme acik kalir.
  const conflict = await call('POST', '/sync/mutations', {
    deviceId: 'dev-e2e-license',
    mutations: [
      {
        clientOpId: ulid(),
        type: 'ADD_LINE',
        payload: { orderId: 'yok-boyle-adisyon', productId: product.data.id, quantity: 1000 },
      },
    ],
  });
  const reviewId = conflict.data.results?.[0]?.reviewId;
  const resolve = await call('POST', `/offline-reviews/${reviewId}/resolve`, {
    resolution: 'yeni_adisyon',
  });
  const stillOpen = (await call('GET', '/offline-reviews')).data;
  t.check(
    Boolean(reviewId) &&
      locked(resolve) &&
      Array.isArray(stillOpen) &&
      stillOpen.some((r) => r.id === reviewId),
    `inceleme "yeni adisyon" kilitliyken 403, inceleme acik kalir (${resolve.status})`,
  );

  // --- Yenileme kilidi hemen kaldirir ---
  const renewed = await call('POST', '/license/activate', {
    licenseKey: license(addDays(new Date(), 365)),
  });
  t.check(
    renewed.status < 400 && renewed.data.locked === false,
    `yenileme kilidi hemen kaldirir (${renewed.data.phase})`,
  );
  const afterRenew = await call('POST', '/orders', { tableId: tables[1].id });
  t.check(afterRenew.status < 400, `yenileme sonrasi yeni adisyon acilir (${afterRenew.status})`);

  // --- Saat geri alma: isaret ileride (daha once gorulmus gelecek an) -> kilit kalir ---
  const future = addDays(new Date(), 400);
  db.prepare("UPDATE application_settings SET value = ? WHERE key = 'license.clock'").run(
    JSON.stringify(future.toISOString()),
  );
  const rolledBack = (await call('GET', '/license')).data;
  t.check(
    rolledBack.locked === true && rolledBack.phase === 'locked',
    `saat geri alinmis gibi (isaret ileride): kilit kalir (${rolledBack.phase})`,
  );
  const rolledOrder = await call('POST', '/orders', { tableId: tables[3].id });
  t.check(
    locked(rolledOrder),
    `sistem saati gecerli dese de yeni adisyon 403 (${rolledOrder.status})`,
  );
} finally {
  db.close();
  await backend.stop(child);
}
t.check(child.exitCode === 0, `duzgun kapanir (kod ${child.exitCode})`);
t.done();

// E2E smoke — calisan sunucuya karsi kritik para yollari.
// Kullanim: backend'i ayaga kaldir (npm run dev) + seed, sonra: node test/smoke.e2e.mjs
// Kapsam: merge, split, payment idempotency, reverse (iade), end-of-day, statement CSV.
import { createCipheriv, createHash, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = process.env.API_PORT || process.env.PORT || 3001;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
let token = '';
const ok = [];
const bad = [];
function assert(cond, msg) {
  (cond ? ok : bad).push(msg);
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
}
const uid = () => 'op-' + Math.random().toString(36).slice(2) + Date.now();
async function waitFor(read, accept, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return value;
}

async function call(method, path, body, raw = false) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text() };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) console.error(`  HTTP ${res.status} ${method} ${path}:`, JSON.stringify(json));
  return { status: res.status, data: json.data ?? json };
}

// Ham dosya yukleme (yedek import).
async function upload(path, bytes, auth = true) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(auth && token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data ?? json };
}

// Baska bir kurulumun yedegi: gecerli SQLite + yedek bicimi (IV + tag + AES-256-GCM, sha256 anahtar).
function foreignBackup(rawKey) {
  const file = join(tmpdir(), `ado-foreign-${Date.now()}.db`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
  db.close();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(rawKey).digest(), iv);
  const enc = Buffer.concat([cipher.update(readFileSync(file)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

// Sunucunun restore isaretini yazdigi veri dizini (backend resolveDataDir ile ayni kural).
function dataDir() {
  if (process.env.ADO_DATA_DIR?.trim()) return process.env.ADO_DATA_DIR.trim();
  const url = process.env.DATABASE_URL ?? '';
  return url.startsWith('file:') ? dirname(url.slice(5)) : null;
}

async function openOrderWithItem(tableId, prodId, qty = 1000) {
  const { data: o } = await call('POST', '/orders', { tableId });
  await call('POST', `/orders/${o.id}/items`, { productId: prodId, quantity: qty });
  const { data: full } = await call('GET', `/orders/${o.id}`);
  return full;
}

(async () => {
  // login
  const { data: login } = await call('POST', '/auth/login', {
    username: 'owner',
    password: 'owner1234',
  });
  token = login.accessToken || login.token || login.access_token;
  assert(!!token, 'login -> token');

  // katalog + salon + masalar (tek sefer)
  const { data: unit } = await call('POST', '/units', { name: 'Adet', abbreviation: 'ad' });
  const { data: cat } = await call('POST', '/categories', { name: 'Yemek ' + Date.now() });
  const { data: tax } = await call('POST', '/taxes', { name: 'KDV10', ratePermille: 100 });
  const { data: prod } = await call('POST', '/products', {
    name: 'Kofte',
    categoryId: cat.id,
    unitId: unit.id,
    taxId: tax.id,
    salePrice: 10000,
  });
  const { data: hall } = await call('POST', '/halls', { name: 'Salon ' + Date.now() });
  const mk = async (n) => (await call('POST', '/tables', { hallId: hall.id, name: n })).data;
  const t1 = await mk('M1'),
    t2 = await mk('M2'),
    t3 = await mk('M3'),
    t4 = await mk('M4');
  assert(!!prod.id && !!t1.id, 'katalog + masalar hazir');
  const { status: cashlessStatus } = await call('POST', '/orders', { tableId: t4.id });
  assert(cashlessStatus === 409, `acik kasa olmadan adisyon reddedildi (${cashlessStatus})`);
  const { status: cashOpenStatus } = await call('POST', '/cash/sessions/open', {
    openingFloat: 0,
  });
  assert(cashOpenStatus < 400, `kasa oturumu acildi (${cashOpenStatus})`);
  const { data: cashStatus } = await call('GET', '/cash/status');
  assert(cashStatus.open === true, 'kasa durumu acik');
  const closeGuardOrder = await openOrderWithItem(t4.id, prod.id);
  const { status: earlyCloseStatus } = await call('POST', '/cash/sessions/close', {
    countedAmount: 0,
  });
  assert(
    earlyCloseStatus === 409,
    `acik adisyon varken kasa kapatma reddedildi (${earlyCloseStatus})`,
  );
  await call('POST', `/orders/${closeGuardOrder.id}/cancel`, { reason: 'kasa koruma testi' });
  const { data: printer } = await call('POST', '/printers', {
    name: 'E2E Mock Printer',
    driverId: 'escpos-mock',
    connection: 'usb',
    paperWidth: '80',
    isDefault: true,
  });
  assert(!!printer.id, 'mock yazici hazir');

  // --- MERGE: iki adisyon (10000 + 10000) -> 20000, kaynak iptal ---
  const A = await openOrderWithItem(t1.id, prod.id);
  const B = await openOrderWithItem(t2.id, prod.id);
  assert(A.grandTotal === 10000, `A grandTotal=10000 (${A.grandTotal})`);
  const { data: merged } = await call('POST', `/orders/${A.id}/merge`, { sourceOrderId: B.id });
  assert(merged.grandTotal === 20000, `MERGE 20000 (${merged.grandTotal})`);
  assert(merged.items.length === 2, `MERGE 2 kalem (${merged.items.length})`);
  const { data: Bx } = await call('GET', `/orders/${B.id}`);
  assert(Bx.status === 'cancelled', `MERGE kaynak iptal (${Bx.status})`);

  // --- SPLIT: A'dan bir kalem t2'ye -> yeni 10000, A 10000 ---
  const { data: split } = await call('POST', `/orders/${A.id}/split`, {
    itemIds: [merged.items[0].id],
    targetTableId: t2.id,
  });
  assert(split.created.grandTotal === 10000, `SPLIT yeni 10000 (${split.created?.grandTotal})`);
  assert(split.source.grandTotal === 10000, `SPLIT kaynak 10000 (${split.source?.grandTotal})`);
  assert(split.created.parentOrderId === A.id, 'SPLIT parentOrderId=A');
  const bothIds = split.source.items.map((i) => i.id);
  const { status: splitAllStatus } = await call('POST', `/orders/${A.id}/split`, {
    itemIds: bothIds,
  });
  assert(splitAllStatus === 400, `SPLIT tum kalemler reddedildi (${splitAllStatus})`);

  // --- PAYMENT idempotency + REVERSE --- (record -> order-with-payments doner)
  const C = await openOrderWithItem(t3.id, prod.id);
  const idem = uid();
  const body = { method: 'cash', amount: C.grandTotal, idempotencyKey: idem };
  const { data: pay1 } = await call('POST', `/orders/${C.id}/payments`, body);
  const payId = (pay1.payments || []).find((p) => p.amount > 0)?.id || pay1.payments?.[0]?.id;
  assert(!!payId, 'PAY kaydedildi (payments[].id)');
  assert(pay1.status === 'completed', `PAY -> completed (${pay1.status})`);
  // ayni idempotencyKey -> ikinci cagri yeni odeme yaratmamali
  const { data: pay2 } = await call('POST', `/orders/${C.id}/payments`, body);
  const active = (pay2.payments || []).filter((p) => !p.deletedAt);
  assert(active.length === 1, `IDEMPOTENCY: tek odeme (${active.length})`);

  const { status: revStatus, data: rev } = await call(
    'POST',
    `/orders/${C.id}/payments/${payId}/reverse`,
    { reason: 'test iade', idempotencyKey: uid() },
  );
  assert(revStatus < 400, `REVERSE 2xx (${revStatus})`);
  assert(
    rev.status === 'refunded' || rev.status === 'open',
    `REVERSE -> refunded/open (${rev.status})`,
  );
  const { data: repaid } = await call('POST', `/orders/${C.id}/payments`, {
    method: 'cash',
    amount: C.grandTotal,
    idempotencyKey: uid(),
  });
  assert(repaid.status === 'completed', `REVERSE sonrasi yeniden odeme (${repaid.status})`);
  const dailyWithReceipt = await waitFor(
    async () => (await call('GET', '/reports/sales/daily')).data,
    (report) =>
      report?.receipts?.some(
        (receipt) => receipt.orderNo === C.orderNo && receipt.type === 'customer',
      ),
  );
  const customerReceipts = (dailyWithReceipt?.receipts ?? []).filter(
    (receipt) => receipt.orderNo === C.orderNo && receipt.type === 'customer',
  );
  assert(customerReceipts.length === 1, `odendi fisi tek basildi (${customerReceipts.length})`);

  // --- END-OF-DAY ---
  const today = new Date().toISOString().slice(0, 10);
  const { data: eod } = await call('GET', `/reports/end-of-day?date=${today}`);
  assert(!!eod.sales && Array.isArray(eod.payments) && !!eod.cash, 'END-OF-DAY yapisi');

  // --- STATEMENT CSV ---
  const { data: cust } = await call('POST', '/customers', { name: 'Ahmet Veresiye' });
  await call('POST', `/customers/${cust.id}/debt`, { amount: 5000, note: 'Test' });
  const stmt = await call('GET', `/customers/${cust.id}/statement.csv`, null, true);
  assert(stmt.status === 200 && stmt.text.includes('Bakiye'), `STATEMENT CSV 200 (${stmt.status})`);
  assert(stmt.text.includes('50.00'), 'STATEMENT 5000kr -> 50.00 TL');

  // --- USERS: olustur/listele/pasiflestir/sil + kendi hesabini silme korumasi ---
  const uname = 'garson' + Date.now();
  const waiterPin = String(Math.floor(100000 + Math.random() * 900000));
  const { data: nu } = await call('POST', '/users', {
    username: uname,
    displayName: 'Test Garson',
    role: 'waiter',
    pin: waiterPin,
  });
  assert(!!nu.id, 'USER create (waiter)');
  const { data: ulist } = await call('GET', '/users');
  assert(
    ulist.some((u) => u.id === nu.id),
    'USER listede',
  );
  const { status: deact } = await call('PATCH', `/users/${nu.id}`, { isActive: false });
  assert(deact < 400, `USER pasiflestir (${deact})`);
  const self = ulist.find((u) => u.username === 'owner');
  const { status: selfDel } = await call('DELETE', `/users/${self.id}`);
  assert(selfDel === 403, `USER self-delete 403 (${selfDel})`);
  const { status: udel } = await call('DELETE', `/users/${nu.id}`);
  assert(udel < 400, `USER sil (${udel})`);

  // --- CLOUD YEDEK: cloudDir doluysa sifreli dosya kopyalanir, bossa kopya yok ---
  const cloudDir = join(tmpdir(), 'ado-cloud-' + Date.now());
  await call('PUT', '/settings/' + encodeURIComponent('backup.cloudDir'), { value: cloudDir });
  const { data: bk } = await call('POST', '/backups');
  assert(bk.cloudCopied === true, `cloud yedek kopyalandi (${bk.cloudCopied})`);
  assert(
    existsSync(cloudDir) && readdirSync(cloudDir).length === 1,
    'cloud klasorunde 1 dosya var',
  );
  await call('PUT', '/settings/' + encodeURIComponent('backup.cloudDir'), { value: '' });
  const { data: bk2 } = await call('POST', '/backups');
  assert(bk2.cloudCopied === false, `cloudDir bos -> kopya yok (${bk2.cloudCopied})`);

  // --- YEDEK KURTARMA: anahtar gosterimi + disaridan yedek + baska kurulumun anahtari ---
  const { status: wrongPw } = await call('POST', '/backups/recovery-key', { password: 'yanlis' });
  assert(wrongPw === 403, `KURTARMA yanlis yonetici sifresi reddedildi (${wrongPw})`);
  const { status: rkStatus, data: rk } = await call('POST', '/backups/recovery-key', {
    password: 'owner1234',
  });
  assert(
    rkStatus === 201 && typeof rk.recoveryKey === 'string' && rk.recoveryKey.length >= 16,
    `KURTARMA anahtar gosterildi (${rkStatus})`,
  );

  const own = await upload('/backups/import', readFileSync(bk.path));
  assert(
    own.status === 201 && own.data.type === 'imported',
    `IMPORT yedek yuklendi (${own.status})`,
  );
  const ownRestore = await call('POST', `/backups/${own.data.id}/restore`, {});
  assert(
    ownRestore.status === 201 && ownRestore.data.staged && ownRestore.data.keyAdopted === false,
    `IMPORT ayni kurulum yedegi anahtarsiz staged (${ownRestore.status})`,
  );

  const foreignKey = randomBytes(32).toString('hex');
  const foreign = await upload('/backups/import', foreignBackup(foreignKey));
  const needKey = await call('POST', `/backups/${foreign.data.id}/restore`, {});
  assert(
    needKey.status === 409 && needKey.data?.error?.code === 'BACKUP_KEY_REQUIRED',
    `IMPORT baska kurulum -> anahtar istenir (${needKey.status})`,
  );
  const wrongKey = await call('POST', `/backups/${foreign.data.id}/restore`, {
    recoveryKey: randomBytes(32).toString('hex'),
  });
  assert(
    wrongKey.status === 400 && wrongKey.data?.error?.code === 'BACKUP_DECRYPT_FAILED',
    `IMPORT yanlis kurtarma anahtari reddedildi (${wrongKey.status})`,
  );
  // Sahibi anahtari gosterildigi gibi (tireli) ya da buyuk harfle yazabilir.
  const typedKey = foreignKey.match(/.{4}/g).join('-').toUpperCase();
  const withKey = await call('POST', `/backups/${foreign.data.id}/restore`, {
    recoveryKey: typedKey,
  });
  assert(
    withKey.status === 201 && withKey.data.staged && withKey.data.keyAdopted === true,
    `IMPORT kurtarma anahtariyla staged + anahtar tasinir (${withKey.status})`,
  );
  const dir = dataDir();
  if (dir) {
    const marker = JSON.parse(readFileSync(join(dir, 'restore-pending.json'), 'utf8'));
    assert(marker.backupKey === foreignKey, 'IMPORT restore isareti tasinan anahtari tasiyor');
  }
  const tiny = await upload('/backups/import', Buffer.from('kisa'));
  assert(tiny.status === 400, `IMPORT gecersiz dosya reddedildi (${tiny.status})`);
  const setupImport = await upload('/backups/setup/import', Buffer.alloc(64), false);
  assert(
    setupImport.status === 403,
    `SETUP geri yukleme kullanici varken kapali (${setupImport.status})`,
  );

  // --- SSE: canli sinyal akisi (200 + order.* olayi + tokensiz 401) ---
  const sse = await fetch(`${BASE}/events/stream`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
  });
  assert(sse.status === 200, `SSE baglanti 200 (${sse.status})`);
  assert((sse.headers.get('content-type') || '').includes('text/event-stream'), 'SSE content-type');
  const reader = sse.body.getReader();
  const firstEvent = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return buf;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('order.')) return buf;
    }
  })();
  const t5 = await mk('M5');
  await call('POST', '/orders', { tableId: t5.id }); // order.* olayi tetikler
  const msg = await Promise.race([firstEvent, new Promise((r) => setTimeout(() => r(''), 5000))]);
  assert(msg.includes('order.'), `SSE order.* olayi alindi (${JSON.stringify(msg.slice(0, 80))})`);
  await reader.cancel().catch(() => {});
  const noTok = await fetch(`${BASE}/events/stream`);
  noTok.body?.cancel?.();
  assert(noTok.status === 401, `SSE tokensiz 401 (${noTok.status})`);
  const queryTok = await fetch(`${BASE}/events/stream?token=${encodeURIComponent(token)}`);
  queryTok.body?.cancel?.();
  assert(queryTok.status === 401, `SSE query token reddedildi (${queryTok.status})`);

  // --- GUVENLIK: hassas ayarlar kapali, audit zinciri dogrulanabilir ---
  const { status: unsafeSetting } = await call(
    'PUT',
    '/settings/' + encodeURIComponent('license.enforce'),
    { value: 'true' },
  );
  assert(unsafeSetting === 400, `SETTINGS hassas anahtar reddedildi (${unsafeSetting})`);
  const { data: auditVerify } = await call('GET', '/audit/verify');
  assert(auditVerify.valid === true, `AUDIT zinciri gecerli (${auditVerify.valid})`);

  // --- SYNC: offline push (applied/duplicate/merge/conflict/review/rejected) ---
  const t6 = await mk('M6');
  const opOpen = uid(),
    opLine = uid(),
    opSubmit = uid();
  const pushBody = {
    deviceId: 'dev-smoke',
    mutations: [
      { clientOpId: opOpen, type: 'OPEN_TABLE', payload: { tableId: t6.id } },
      {
        clientOpId: opLine,
        type: 'ADD_LINE',
        payload: { orderClientOpId: opOpen, productId: prod.id, quantity: 1000 },
      },
      { clientOpId: opSubmit, type: 'SUBMIT_ORDER', payload: { orderClientOpId: opOpen } },
    ],
  };
  const { data: push1 } = await call('POST', '/sync/mutations', pushBody);
  assert(
    push1.results?.every((r) => r.status === 'applied'),
    `SYNC push 3x applied (${JSON.stringify(push1.results?.map((r) => r.status))})`,
  );
  const syncOrderId = push1.results[0].serverId;
  const { data: syncOrder } = await call('GET', `/orders/${syncOrderId}`);
  assert(syncOrder.grandTotal === 10000, `SYNC adisyon 10000 (${syncOrder.grandTotal})`);
  assert(
    syncOrder.items[0]?.status === 'sent',
    `SYNC kalem mutfaga gitti (${syncOrder.items[0]?.status})`,
  );

  // replay -> duplicate, yeni kayit yok
  const { data: push2 } = await call('POST', '/sync/mutations', pushBody);
  assert(
    push2.results?.every((r) => r.status === 'duplicate'),
    `SYNC replay 3x duplicate (${JSON.stringify(push2.results?.map((r) => r.status))})`,
  );
  const { data: syncOrder2 } = await call('GET', `/orders/${syncOrderId}`);
  assert(syncOrder2.items.length === 1, `SYNC replay kalem coglamadi (${syncOrder2.items.length})`);

  // snapshot: acik adisyon + katalog tek istekte
  const { data: snap } = await call('GET', '/sync/snapshot');
  assert(
    snap.orders?.some((o) => o.id === syncOrderId) &&
      snap.products?.length > 0 &&
      !!snap.serverTime,
    'SYNC snapshot (orders+products+serverTime)',
  );

  // conflict: adisyon kapatildiktan sonra gelen offline kalem -> Owner review
  await call('POST', `/orders/${syncOrderId}/cancel`, { reason: 'sync test' });
  const opLate = uid();
  const { data: push3 } = await call('POST', '/sync/mutations', {
    deviceId: 'dev-smoke',
    mutations: [
      {
        clientOpId: opLate,
        type: 'ADD_LINE',
        payload: { orderId: syncOrderId, productId: prod.id, quantity: 2000 },
      },
    ],
  });
  const conf = push3.results?.[0];
  assert(
    conf?.status === 'conflict' && !!conf?.reviewId,
    `SYNC kapali adisyon -> conflict+review (${conf?.status})`,
  );
  const { data: reviews } = await call('GET', '/offline-reviews');
  assert(
    reviews.some((r) => r.id === conf.reviewId),
    'SYNC review listede',
  );

  // resolve: yeni_adisyon -> kalem yeni adisyona uygulanir, review kapanir
  const { data: resolved } = await call('POST', `/offline-reviews/${conf.reviewId}/resolve`, {
    resolution: 'yeni_adisyon',
  });
  assert(
    resolved.review?.status === 'resolved',
    `SYNC review resolved (${resolved.review?.status})`,
  );
  assert(
    resolved.result?.status === 'applied',
    `SYNC review kalem applied (${resolved.result?.status})`,
  );
  const { data: reviews2 } = await call('GET', '/offline-reviews');
  assert(!reviews2.some((r) => r.id === conf.reviewId), 'SYNC review listeden dustu');

  // rejected: olmayan urun -> PRODUCT_INACTIVE
  const { data: push4 } = await call('POST', '/sync/mutations', {
    deviceId: 'dev-smoke',
    mutations: [
      {
        clientOpId: uid(),
        type: 'ADD_LINE',
        payload: { orderClientOpId: opOpen, productId: 'yok-boyle-urun', quantity: 1000 },
      },
    ],
  });
  assert(
    push4.results?.[0]?.status === 'rejected' && push4.results?.[0]?.reason === 'PRODUCT_INACTIVE',
    `SYNC olmayan urun rejected (${push4.results?.[0]?.reason})`,
  );

  // sync/health token'siz erisilir
  const sh = await fetch(`${BASE}/sync/health`);
  assert(sh.status === 200, `SYNC health tokensiz 200 (${sh.status})`);

  // --- STOK: dusum MUTFAGA GONDERINCE; pending kalem + remove sizinti YAPMAZ ---
  const { data: stockProd } = await call('POST', '/products', {
    name: 'StokUrun ' + Date.now(),
    categoryId: cat.id,
    unitId: unit.id,
    taxId: tax.id,
    salePrice: 5000,
    trackStock: true,
  });
  const { data: stockTable } = await call('POST', '/tables', {
    hallId: hall.id,
    name: 'SM' + Date.now(),
  });
  const { data: sOrder } = await call('POST', '/orders', { tableId: stockTable.id });
  await call('POST', `/orders/${sOrder.id}/items`, { productId: stockProd.id, quantity: 2000 }); // A
  await call('POST', `/orders/${sOrder.id}/items`, { productId: stockProd.id, quantity: 1000 }); // B
  let { data: mv } = await call('GET', `/inventory/movements/${stockProd.id}`);
  assert((mv?.length ?? 0) === 0, `STOK pending kalemde hareket yok (${mv?.length})`);
  // B kalemini (pending) sil -> mutfaga gonderilince DUSMEMELI (sizinti yok)
  const { data: full } = await call('GET', `/orders/${sOrder.id}`);
  const itemB = full.items.find((i) => i.quantity === 1000);
  await call('DELETE', `/orders/${sOrder.id}/items/${itemB.id}`);
  // mutfaga gonder -> yalniz A (2000) duser; silinen B sizmaz
  await call('POST', `/orders/${sOrder.id}/send-kitchen`);
  mv = await waitFor(
    async () => (await call('GET', `/inventory/movements/${stockProd.id}`)).data,
    (rows) => rows?.some((movement) => movement.quantity < 0),
  );
  const neg = (mv ?? []).filter((m) => m.quantity < 0);
  assert(
    neg.length === 1 && neg[0].quantity === -2000,
    `STOK: yalniz gonderilen kalem dustu -2000, silinen sizmadi (${JSON.stringify(neg.map((m) => m.quantity))})`,
  );

  // --- SIPARIS NOTU + MASA BILGISI + BOS ADISYONU KAPATMA ---
  const tNote = await mk('NOT' + Date.now());
  const N = await openOrderWithItem(tNote.id, prod.id);
  const noteItemId = N.items[0].id;
  const { status: noteStatus, data: noted } = await call(
    'PUT',
    `/orders/${N.id}/items/${noteItemId}/note`,
    { note: 'az pişmiş' },
  );
  assert(
    noteStatus === 200 && noted.items[0].notes?.[0]?.note === 'az pişmiş',
    `NOT gonderilmemis kaleme yazildi (${noteStatus})`,
  );
  assert(
    noted.table?.name === tNote.name && !!noted.table?.hall?.name,
    'SIPARIS yanitinda masa + salon',
  );
  const { status: discardFull } = await call('POST', `/orders/${N.id}/discard`);
  assert(discardFull === 409, `BOS ADISYON: kalemli adisyon kapatilmaz (${discardFull})`);
  await call('POST', `/orders/${N.id}/send-kitchen`);
  const { status: noteSent } = await call('PUT', `/orders/${N.id}/items/${noteItemId}/note`, {
    note: 'x',
  });
  assert(noteSent === 409, `NOT gonderilmis kaleme yazilmaz (${noteSent})`);
  const kitchenJobs = await waitFor(
    async () => (await call('GET', '/printers/jobs')).data,
    (jobs) => jobs?.some((j) => j.documentType === 'kitchen' && j.summary.endsWith(N.orderNo)),
  );
  const kitchenText =
    kitchenJobs?.find((j) => j.documentType === 'kitchen' && j.summary.endsWith(N.orderNo))?.text ??
    '';
  assert(
    kitchenText.includes(`Masa: ${hall.name} · ${tNote.name}`) &&
      kitchenText.includes('Not: az pişmiş'),
    'MUTFAK FISI masa + not iceriyor',
  );
  const tEmpty = await mk('BOS' + Date.now());
  const { data: E } = await call('POST', '/orders', { tableId: tEmpty.id });
  const { status: discardStatus, data: discarded } = await call('POST', `/orders/${E.id}/discard`);
  assert(
    discardStatus < 400 && discarded.status === 'cancelled',
    `BOS ADISYON kapatildi (${discardStatus} ${discarded.status})`,
  );
  const { data: emptyOpen } = await call('GET', `/orders?tableId=${tEmpty.id}&open=true`);
  assert(emptyOpen.length === 0, 'BOS ADISYON masayi bosaltti');

  // --- ISLETME BILGILERI (fis basligi) ---
  const { status: bizStatus } = await call('PUT', '/settings/business', {
    name: 'Smoke Lokanta',
    address: 'Test Sok. 1',
    phone: '0212 111 11 11',
  });
  const { data: biz } = await call('GET', '/settings/business');
  assert(
    bizStatus === 200 && biz.name === 'Smoke Lokanta' && biz.phone === '0212 111 11 11',
    `ISLETME bilgileri kaydedildi (${bizStatus})`,
  );
  const { status: bizBad } = await call('PUT', '/settings/business', { name: '  ' });
  assert(bizBad === 422, `ISLETME bos ad reddedilir (${bizBad})`);

  // --- FIS YENIDEN YAZDIR + KASADA IADE ISARETI (C: iade + yeniden odeme) ---
  const { status: reprintStatus } = await call('POST', `/printers/order/${C.id}/receipt`);
  assert(reprintStatus < 400, `FIS odenmis adisyonda yeniden yazdirilir (${reprintStatus})`);
  const { status: reprintUnpaid } = await call('POST', `/printers/order/${N.id}/receipt`);
  assert(reprintUnpaid === 409, `FIS odenmemis adisyonda yeniden yazdirilmaz (${reprintUnpaid})`);
  const { data: shift } = await call('GET', '/reports/shift');
  const reversedRow = shift.recentPayments?.find((p) => p.id === payId);
  assert(
    reversedRow?.reversed === true && reversedRow.orderId === C.id,
    'KASA son islemlerde iade edilen odeme isaretli',
  );

  // --- YAZICI: kesif, basilamayan fis listesi, tekrar dene / kaldir ---
  const { status: discStatus, data: disc } = await call('GET', '/printers/discover');
  assert(
    discStatus === 200 && Array.isArray(disc) && disc.some((d) => d.driverId === 'escpos-mock'),
    `YAZICI kesif listesi (${discStatus})`,
  );
  const { data: badPrinter } = await call('POST', '/printers', {
    name: 'Olmayan Yazici',
    driverId: 'windows-spooler',
    connection: 'windows_spooler',
    address: 'Olmayan Yazici',
    paperWidth: '80',
  });
  const { data: testJob } = await call('POST', `/printers/test-print/${badPrinter.id}`);
  const failedOf = async () => (await call('GET', '/printers/jobs?status=failed')).data;
  const hasJob = (jobs) => jobs?.some((j) => j.id === testJob.jobId);
  assert(
    hasJob(await waitFor(failedOf, hasJob, 8000)),
    'YAZICI basilamayan fis "failed" listesinde',
  );
  const { status: retryStatus } = await call('POST', `/printers/jobs/${testJob.jobId}/retry`);
  assert(retryStatus < 400, `YAZICI tekrar dene (${retryStatus})`);
  await waitFor(failedOf, hasJob, 8000);
  const { status: dismissStatus } = await call('DELETE', `/printers/jobs/${testJob.jobId}`);
  assert(
    dismissStatus < 400 && !hasJob(await failedOf()),
    `YAZICI kaldirilan fis listeden cikti (${dismissStatus})`,
  );
  const doneJob = (await call('GET', '/printers/jobs?status=done')).data?.[0];
  if (doneJob) {
    const { status: retryDone } = await call('POST', `/printers/jobs/${doneJob.id}/retry`);
    assert(retryDone === 409, `YAZICI basilmis fis tekrar denenmez (${retryDone})`);
  }
  const { status: unknownTest } = await call('POST', '/printers/test-print/yok');
  assert(unknownTest === 404, `YAZICI olmayan yaziciya test sayfasi 404 (${unknownTest})`);
  await call('DELETE', `/printers/${badPrinter.id}`);

  // --- QR MENU (POS): menu alanlari, tukendi, gorsel, masa kodu ---
  const { status: qrCatStatus, data: qrCat } = await call('POST', '/categories', {
    name: 'Çorbalar ' + Date.now(),
    translations: { en: { name: 'Soups' } },
  });
  const { data: catList } = await call('GET', '/categories');
  assert(
    qrCatStatus < 400 &&
      qrCat.translations?.en?.name === 'Soups' &&
      catList.find((c) => c.id === qrCat.id)?.translations?.en?.name === 'Soups',
    `QR kategori cevirisi kaydedildi (${qrCatStatus})`,
  );
  const { status: qrProdStatus, data: qrProd } = await call('POST', '/products', {
    name: 'Mercimek Çorbası',
    categoryId: qrCat.id,
    unitId: unit.id,
    taxId: tax.id,
    salePrice: 12000,
    description: '  Günlük taze  ',
    allergens: ['gluten', 'celery', 'gluten'],
    dietTags: ['vegan'],
    translations: { en: { name: 'Lentil soup', description: ' ' } },
  });
  assert(
    qrProdStatus < 400 &&
      qrProd.description === 'Günlük taze' &&
      JSON.stringify(qrProd.allergens) === '["gluten","celery"]' &&
      JSON.stringify(qrProd.dietTags) === '["vegan"]' &&
      JSON.stringify(qrProd.translations) === '{"en":{"name":"Lentil soup"}}' &&
      qrProd.isAvailable === true &&
      !('allergensJson' in qrProd),
    `QR urun menu alanlari kaydedildi, cozulmus doner (${qrProdStatus})`,
  );
  const { status: badAllergen } = await call('PATCH', `/products/${qrProd.id}`, {
    allergens: ['nut'],
  });
  assert(badAllergen === 422, `QR bilinmeyen alerjen reddedilir (${badAllergen})`);
  const { data: qrSnap } = await call('GET', '/sync/snapshot');
  const snapProd = qrSnap.products?.find((p) => p.id === qrProd.id);
  assert(
    Array.isArray(snapProd?.allergens) && !('allergensJson' in snapProd),
    'QR sync snapshot urunleri API ile ayni gorunumde',
  );

  const { data: soldOut } = await call('PATCH', `/products/${qrProd.id}/availability`, {
    isAvailable: false,
  });
  const tQr = await mk('QR' + Date.now());
  const { data: qrOrder } = await call('POST', '/orders', { tableId: tQr.id });
  const addQr = () =>
    call('POST', `/orders/${qrOrder.id}/items`, { productId: qrProd.id, quantity: 1000 });
  const { status: soldOutAdd, data: soldOutErr } = await addQr();
  assert(
    soldOut.isAvailable === false &&
      soldOutAdd === 409 &&
      soldOutErr.error?.code === 'PRODUCT_UNAVAILABLE',
    `QR tukenen urun siparise eklenmez (${soldOutAdd})`,
  );
  await call('PATCH', `/products/${qrProd.id}/availability`, { isAvailable: true });
  const { status: backAdd } = await addQr();
  assert(backAdd < 400, `QR tekrar satista olan urun eklenir (${backAdd})`);
  await call('POST', `/orders/${qrOrder.id}/cancel`, { reason: 'QR testi' });

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const pngKey = createHash('sha256').update(png).digest('hex') + '.png';
  const { status: imgStatus, data: withImg } = await upload(`/products/${qrProd.id}/image`, png);
  assert(
    imgStatus < 400 && withImg.imagePath === pngKey,
    `QR gorsel yuklendi, anahtar = icerik ozeti (${imgStatus})`,
  );
  const imgRes = await fetch(`${BASE}/catalog/images/${pngKey}`);
  const imgBody = Buffer.from(await imgRes.arrayBuffer());
  assert(
    imgRes.status === 200 &&
      imgRes.headers.get('content-type') === 'image/png' &&
      (imgRes.headers.get('cache-control') || '').includes('immutable') &&
      imgBody.equals(png),
    `QR gorsel tokensiz sunulur (${imgRes.status} ${imgRes.headers.get('content-type')})`,
  );
  const { status: notImage } = await upload(`/products/${qrProd.id}/image`, Buffer.from('merhaba'));
  assert(notImage === 400, `QR gorsel olmayan dosya reddedilir (${notImage})`);
  const huge = Buffer.concat([png.subarray(0, 8), Buffer.alloc(1024 * 1024)]);
  const { status: hugeStatus } = await upload(`/products/${qrProd.id}/image`, huge);
  assert(hugeStatus === 413, `QR 1 MB ustu gorsel reddedilir (${hugeStatus})`);
  const missingImg = await fetch(`${BASE}/catalog/images/${'0'.repeat(64)}.png`);
  const traversal = await fetch(`${BASE}/catalog/images/..%2F..%2Fpackage.json`);
  assert(
    missingImg.status === 404 && traversal.status === 404,
    `QR olmayan/gecersiz gorsel adi 404 (${missingImg.status} ${traversal.status})`,
  );
  const { data: noImg } = await call('DELETE', `/products/${qrProd.id}/image`);
  assert(noImg.imagePath === null, 'QR gorsel kaldirildi');

  const codeRe = /^[A-Z2-7]{16}$/;
  const { data: tableList } = await call('GET', '/tables');
  const listed = tableList.find((t) => t.id === tQr.id);
  assert(
    codeRe.test(tQr.publicCode ?? '') && listed?.publicCode === tQr.publicCode,
    'QR yeni masaya kod verildi, listede gorunur',
  );
  const { status: rotateStatus, data: rotated } = await call(
    'POST',
    `/tables/${tQr.id}/public-code`,
  );
  assert(
    rotateStatus < 400 &&
      codeRe.test(rotated.publicCode ?? '') &&
      rotated.publicCode !== tQr.publicCode,
    `QR masa kodu yenilendi (${rotateStatus})`,
  );

  // --- YEREL HTTPS (API_TLS_PORT): CA tokensiz indirilir, sunucu bu CA ile dogrulanir ---
  if (process.env.API_TLS_PORT) {
    const caRes = await fetch(`${BASE}/devices/ca.crt`);
    const caDer = Buffer.from(await caRes.arrayBuffer());
    assert(
      caRes.status === 200 && (caRes.headers.get('content-type') || '').includes('x509'),
      `TLS ca.crt tokensiz indirilir (${caRes.status})`,
    );
    const caPem = new X509Certificate(caDer).toString();
    const tlsStatus = await new Promise((resolve) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: Number(process.env.API_TLS_PORT),
          path: '/api/v1/health',
          ca: caPem,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', (e) => resolve(e.code || 'ERR'));
      req.end();
    });
    assert(tlsStatus === 200, `TLS HTTPS yalniz yerel CA ile dogrulandi (${tlsStatus})`);
    const { data: info } = await call('GET', '/devices/server-info');
    assert(
      Array.isArray(info.httpsUrls) && Array.isArray(info.caUrls) && info.httpsPort > 0,
      'TLS server-info HTTPS + sertifika adresleri',
    );
  }

  console.log(`\nE2E SONUC: ${ok.length} gecti, ${bad.length} kaldi`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});

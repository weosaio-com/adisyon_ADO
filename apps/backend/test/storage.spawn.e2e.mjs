// Depolama spawned e2e (kendi portu 3061): akilli yedek saklama ve gunluk temizlik GERCEK dosya
// ve veritabaniyla. Backend acilmadan once veritabanina eski yedekler ve teknik kayitlar, veri
// dizinine artik dosyalar konur; POST /storage/cleanup sonrasi ne silindigi, neye dokunulmadigi
// denetlenir. Disk azaldiysa (bos < %10 / 2 GB) beklenen saklama sonucu ona gore hesaplanir.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checklist, prepareBackend } from './spawn-backend.mjs';

const t = checklist('Depolama: akilli saklama + gunluk temizlik (spawned)');
const backend = prepareBackend({ name: 'storage', port: 3061 });
const { dataDir } = backend;
const backupsDir = join(dataDir, 'backups');
const imagesDir = join(dataDir, 'images');
const cloudDir = mkdtempSync(join(tmpdir(), 'ado-storage-cloud-'));
const elsewhere = mkdtempSync(join(tmpdir(), 'ado-storage-elsewhere-'));
mkdirSync(backupsDir, { recursive: true });
mkdirSync(imagesDir, { recursive: true });

const DAY = 86_400_000;
const now = Date.now();
const db = new DatabaseSync(join(dataDir, 'storage.db'));
const branchId = db.prepare('SELECT id FROM branches LIMIT 1').get().id;
const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
let seq = 0;
const nextId = (prefix) => `${prefix}${String(++seq).padStart(6, '0')}`;
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n);
const setOld = (path, days) => {
  const when = new Date(now - days * DAY);
  utimesSync(path, when, when);
};

// --- Yedek kayitlari (dosyalariyla) ---
const insertBackup = db.prepare(
  `INSERT INTO backups (id, branch_id, path, size_bytes, type, format, encrypted, checksum,
     created_by, cloud_copy_path, created_at, updated_at, deleted_at)
   VALUES (?, ?, ?, 1000, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
);
/** cloud: 'recorded' (yol kayitli) | 'legacy' (kopya var, yol kayitsiz) | 'outside' | null */
function addBackup(type, ageDays, { cloud = null, deleted = false, dir = backupsDir } = {}) {
  const createdAt = now - ageDays * DAY;
  const prefix = type === 'imported' ? 'imported' : 'backup';
  const name = `${prefix}_${stamp(createdAt)}-${++seq}.db.enc`;
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(1000, 1));
  let copy = null;
  if (cloud === 'recorded' || cloud === 'legacy') copy = join(cloudDir, name);
  if (cloud === 'outside') copy = join(elsewhere, name);
  if (copy) writeFileSync(copy, Buffer.alloc(1000, 2));
  const id = nextId('BK');
  const recorded = cloud === 'legacy' ? null : copy;
  insertBackup.run(
    id,
    branchId,
    path,
    type,
    '0'.repeat(64),
    userId,
    recorded,
    createdAt,
    createdAt,
    deleted ? createdAt : null,
  );
  return { id, type, ageDays, path, copy };
}

const autos = [];
for (let i = 0; i < 60; i++) autos.push(addBackup('auto', i + 0.01));
const ancientAutos = [200, 300, 400].map((d) => addBackup('auto', d));
const manualRecent = [addBackup('manual', 1), addBackup('manual', 10), addBackup('manual', 100)];
const manualOldRecorded = addBackup('manual', 150, { cloud: 'recorded' });
const manualOldLegacy = addBackup('manual', 200, { cloud: 'legacy' });
const manualOldOutsideCopy = addBackup('manual', 120, { cloud: 'outside' });
const manualOutsideDir = addBackup('manual', 300, { dir: elsewhere });
const preUpdates = [addBackup('pre_update', 100), addBackup('pre_update', 130)];
const imported = addBackup('imported', 5);
// Daha once silinmis ama bulut kopyasi kilitli kalmis kayit: kopya bu calismada silinir.
const pendingCopy = addBackup('manual', 400, { cloud: 'recorded', deleted: true });
// Bulut klasorunde bizim olmayan dosyalar: dokunulmaz.
const strangerPdf = join(cloudDir, 'fatura.pdf');
const strangerBackup = join(cloudDir, 'backup_baska-bilgisayar.db.enc');
writeFileSync(strangerPdf, 'pdf');
writeFileSync(strangerBackup, 'baska');

// --- Teknik kayitlar ---
const insertJob = db.prepare(
  `INSERT INTO background_jobs (id, branch_id, task_name, payload, status, run_at, created_at, updated_at)
   VALUES (?, ?, 'e2e.noop', '{}', ?, ?, ?, ?)`,
);
const job = (status, ageDays, runInFuture = false) => {
  const id = nextId('JB');
  const at = now - ageDays * DAY;
  insertJob.run(id, branchId, status, runInFuture ? now + 10 * DAY : at, at, at);
  return id;
};
const jobsGone = [job('completed', 40), job('failed', 40)];
const jobsKept = [job('completed', 10), job('pending', 40, true)];

const printerId = nextId('PR');
db.prepare(
  `INSERT INTO printers (id, branch_id, name, driver_id, connection, paper_width, created_at, updated_at)
   VALUES (?, ?, 'E2E', 'escpos-mock', 'usb', 80, ?, ?)`,
).run(printerId, branchId, now, now);
const insertPrint = db.prepare(
  `INSERT INTO print_jobs (id, branch_id, printer_id, document_type, payload, status, created_by,
     created_at, updated_at, deleted_at)
   VALUES (?, ?, ?, 'receipt', '{}', ?, ?, ?, ?, ?)`,
);
const print = (status, ageDays, dismissed = false) => {
  const id = nextId('PJ');
  const at = now - ageDays * DAY;
  insertPrint.run(id, branchId, printerId, status, userId, at, at, dismissed ? at : null);
  return id;
};
const printsGone = [print('done', 100), print('failed', 100, true)];
const printsKept = [print('done', 30), print('failed', 100), print('queued', 100)];

const insertOp = db.prepare(
  `INSERT INTO processed_client_ops (id, branch_id, client_op_id, device_id, mutation_type, result_status, created_at)
   VALUES (?, ?, ?, 'tablet-1', 'order.add', 'applied', ?)`,
);
const op = (ageDays) => {
  const id = nextId('OP');
  insertOp.run(id, branchId, `c-${id}`, now - ageDays * DAY);
  return id;
};
const opsGone = [op(40)];
const opsKept = [op(10)];

const insertSession = db.prepare(
  `INSERT INTO sessions (id, user_id, refresh_token_hash, issued_at, expires_at, revoked_at, created_at, updated_at)
   VALUES (?, ?, 'x', ?, ?, ?, ?, ?)`,
);
const session = (issuedDays, expiresDays, revokedDays = null) => {
  const id = nextId('SE');
  const issued = now - issuedDays * DAY;
  insertSession.run(
    id,
    userId,
    issued,
    now - expiresDays * DAY,
    revokedDays === null ? null : now - revokedDays * DAY,
    issued,
    issued,
  );
  return id;
};
const sessionsGone = [session(80, 50, 40), session(80, 40)];
const sessionsKept = [session(20, -10, 10), session(5, -25)];

// --- Artik dosyalar ---
const orphanOld = join(imagesDir, `${'b'.repeat(64)}.webp`);
const orphanNew = join(imagesDir, `${'c'.repeat(64)}.jpg`);
const imageTemp = join(imagesDir, `${'d'.repeat(64)}.png.0a1b2c3d4e5f.tmp`);
const imageNote = join(imagesDir, 'notlar.txt');
for (const path of [orphanOld, orphanNew, imageTemp, imageNote]) writeFileSync(path, 'img');
setOld(orphanOld, 10);
setOld(imageTemp, 10);
setOld(imageNote, 100);

const tempOld = join(backupsDir, 'temp_01OLD.db');
const tempEncOld = join(backupsDir, 'temp_01OLD.db.enc');
const tempNew = join(backupsDir, 'temp_01NEW.db');
const stagingOld = join(backupsDir, 'restore_staging_01OLD.db');
const stagingPending = join(backupsDir, 'restore_staging_01PENDING.db');
const backupsNote = join(backupsDir, 'notlar.txt');
for (const path of [tempOld, tempEncOld, tempNew, stagingOld, stagingPending, backupsNote]) {
  writeFileSync(path, 'x');
}
for (const path of [tempOld, tempEncOld, stagingOld, stagingPending, backupsNote]) setOld(path, 3);
writeFileSync(
  join(dataDir, 'restore-pending.json'),
  JSON.stringify({ stagePath: stagingPending, createdAt: new Date(now).toISOString() }),
);
const preRestore = [1_700_000_000_000, 1_750_000_000_000, 1_760_000_000_000].map((ms) =>
  join(dataDir, `ado.pre-restore-${ms}.db`),
);
for (const path of preRestore) writeFileSync(path, 'kopya');
writeFileSync(join(dataDir, 'backend-error.log'), 'x'.repeat(500));
writeFileSync(join(dataDir, 'backend-error.log.1'), 'y'.repeat(300));

const businessCounts = () => ({
  users: count('SELECT COUNT(*) AS n FROM users'),
  roles: count('SELECT COUNT(*) AS n FROM roles'),
  branches: count('SELECT COUNT(*) AS n FROM branches'),
  printers: count('SELECT COUNT(*) AS n FROM printers'),
  products: count('SELECT COUNT(*) AS n FROM products'),
});

const child = await backend.start();
try {
  const token = await backend.login();
  await backend.call('PUT', `/settings/${encodeURIComponent('backup.cloudDir')}`, {
    value: cloudDir,
  });

  // Urune bagli eski gorsel silinmez (urun API ile; dosya tarihi geri alinir).
  const unit = (await backend.call('POST', '/units', { name: 'Adet', abbreviation: 'ad' })).data;
  const cat = (await backend.call('POST', '/categories', { name: 'Yemek' })).data;
  const tax = (await backend.call('POST', '/taxes', { name: 'KDV10', ratePermille: 100 })).data;
  const product = (
    await backend.call('POST', '/products', {
      name: 'Kofte',
      categoryId: cat.id,
      unitId: unit.id,
      taxId: tax.id,
      salePrice: 10000,
    })
  ).data;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const pngPath = join(imagesDir, `${createHash('sha256').update(png).digest('hex')}.png`);
  const uploaded = await fetch(`${backend.base}/products/${product.id}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
    body: png,
  });
  t.check(uploaded.ok && existsSync(pngPath), `urun gorseli yuklendi (${uploaded.status})`);
  setOld(pngPath, 30);

  const before = await backend.call('GET', '/storage');
  const lowDisk = before.data.lowDisk === true;
  if (lowDisk) console.log('  (disk azaldi kipi: saklama beklentileri buna gore)');
  const liveBefore = count('SELECT COUNT(*) AS n FROM backups WHERE deleted_at IS NULL');
  t.check(
    before.status === 200 && before.data.backups.count === liveBefore,
    `GET /storage yedek sayisi = canli kayit (${before.data.backups?.count}/${liveBefore})`,
  );
  t.check(before.data.logsBytes >= 800, `kayit dosyalari sayilir (${before.data.logsBytes})`);
  t.check(before.data.imagesBytes > 0 && before.data.dbBytes > 0, 'gorsel ve veritabani boyutu');
  const auditBefore = count('SELECT COUNT(*) AS n FROM audit_logs');
  const business = businessCounts();

  const cleanup = await backend.call('POST', '/storage/cleanup');
  const summary = cleanup.data;
  t.check(
    cleanup.status === 201 && summary.trigger === 'manual',
    `temizlik calisti (${cleanup.status})`,
  );
  t.check(summary.lowDisk === lowDisk, 'ozetteki disk kipi');

  // --- Yedekler ---
  const live = (id) =>
    count('SELECT COUNT(*) AS n FROM backups WHERE id = ? AND deleted_at IS NULL', id) === 1;
  const keptAutos = autos.filter((b) => live(b.id));
  if (lowDisk) {
    t.check(keptAutos.length === 3, `disk azaldi: 3 otomatik kalir (${keptAutos.length})`);
  } else {
    t.check(
      keptAutos.length >= 7 && keptAutos.length <= 19,
      `otomatik: gun/hafta/ay kurallari (${keptAutos.length} kaldi)`,
    );
    // Yerel takvim gunu: son 7 gunde yedegi olan her gunden en az biri kalir.
    const dayOf = (b) => new Date(now - b.ageDays * DAY).toDateString();
    const recentDays = new Set(autos.filter((b) => b.ageDays < 7).map(dayOf));
    const keptDays = new Set(keptAutos.map(dayOf));
    t.check(
      [...recentDays].every((d) => keptDays.has(d)),
      'son 7 gunun her gunu kalir',
    );
  }
  t.check(
    autos.slice(0, 3).every((b) => live(b.id)),
    'en yeni 3 otomatik her zaman kalir',
  );
  t.check(
    ancientAutos.every((b) => !live(b.id) && !existsSync(b.path)),
    '6 aydan eski otomatikler silinir',
  );
  t.check(
    autos.filter((b) => !live(b.id)).every((b) => !existsSync(b.path)),
    'silinen yedeklerin dosyalari da silinir',
  );
  t.check(
    keptAutos.every((b) => existsSync(b.path)),
    'kalan yedeklerin dosyalari durur',
  );

  const expectManual = lowDisk ? [manualRecent[0]] : manualRecent;
  t.check(
    manualRecent.every((b) => live(b.id) === expectManual.includes(b)),
    lowDisk ? 'disk azaldi: yalniz en yeni elle yedek' : 'elle: 90 gun + en yeni 3',
  );
  t.check(
    !live(manualOldRecorded.id) && !existsSync(manualOldRecorded.copy),
    'eski elle yedek + kayitli bulut kopyasi silinir',
  );
  t.check(
    !live(manualOldLegacy.id) && !existsSync(manualOldLegacy.copy),
    'eski kayitta bulut kopyasi ayni adla bulunup silinir',
  );
  t.check(
    !live(manualOldOutsideCopy.id) && existsSync(manualOldOutsideCopy.copy),
    'bulut klasoru disindaki kopyaya dokunulmaz',
  );
  t.check(
    !live(manualOutsideDir.id) && existsSync(manualOutsideDir.path),
    'yedek klasoru disindaki dosyaya dokunulmaz (yalniz kayit)',
  );
  t.check(
    preUpdates.every((b, i) => live(b.id) === (!lowDisk || i === 0)),
    'guncelleme oncesi: en yeni 3 (disk azaldiysa 1)',
  );
  t.check(live(imported.id), 'disaridan yuklenen yeni yedek kalir');
  t.check(
    !existsSync(pendingCopy.copy) &&
      db.prepare('SELECT cloud_copy_path AS p FROM backups WHERE id = ?').get(pendingCopy.id).p ===
        null,
    'once silinemeyen bulut kopyasi tekrar denenip silinir',
  );
  t.check(
    existsSync(strangerPdf) && existsSync(strangerBackup),
    'bulut klasorundeki baska dosyalar durur',
  );
  const deletedBackups = count(
    'SELECT COUNT(*) AS n FROM backups WHERE deleted_at IS NOT NULL AND id != ?',
    pendingCopy.id,
  );
  t.check(
    summary.deleted.backups === deletedBackups,
    `ozet: silinen yedek sayisi (${summary.deleted.backups})`,
  );
  t.check(
    count('SELECT COUNT(*) AS n FROM backups') === liveBefore + 1,
    'yedek kayitlari yalniz silindi isaretlenir (satir silinmez)',
  );

  // --- Teknik kayitlar ---
  const exists = (table, id) => count(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, id) === 1;
  t.check(
    jobsGone.every((id) => !exists('background_jobs', id)),
    'biten eski arka plan isleri silinir',
  );
  t.check(
    jobsKept.every((id) => exists('background_jobs', id)),
    'yeni/bekleyen isler kalir',
  );
  t.check(
    printsGone.every((id) => !exists('print_jobs', id)),
    'basilmis/kaldirilmis eski fis isleri silinir',
  );
  t.check(
    printsKept.every((id) => exists('print_jobs', id)),
    'yeni ve bekleyen fis isleri kalir',
  );
  t.check(
    opsGone.every((id) => !exists('processed_client_ops', id)),
    'eski islem defteri silinir',
  );
  t.check(
    opsKept.every((id) => exists('processed_client_ops', id)),
    'yeni islem defteri kalir',
  );
  t.check(
    sessionsGone.every((id) => !exists('sessions', id)),
    'eski iptal/suresi dolmus oturumlar silinir',
  );
  t.check(
    sessionsKept.every((id) => exists('sessions', id)),
    'gecerli/yeni oturumlar kalir',
  );
  t.check(
    summary.deleted.backgroundJobs === 2 &&
      summary.deleted.printJobs === 2 &&
      summary.deleted.clientOps === 1 &&
      summary.deleted.sessions === 2,
    `ozet: teknik kayit sayilari (${JSON.stringify(summary.deleted)})`,
  );
  t.check(
    count('SELECT COUNT(*) AS n FROM audit_logs') === auditBefore + 1,
    'denetim kaydi silinmez (yalniz temizlik kaydi eklenir)',
  );
  t.check(
    JSON.stringify(businessCounts()) === JSON.stringify(business),
    'isletme tablolari degismez',
  );

  // --- Dosyalar ---
  t.check(
    !existsSync(orphanOld) && !existsSync(imageTemp),
    'sahipsiz eski gorsel ve yarim .tmp silinir',
  );
  t.check(existsSync(orphanNew), 'yeni sahipsiz gorsel kalir (urune baglanmamis olabilir)');
  t.check(existsSync(pngPath), 'urunun gosterdigi eski gorsel kalir');
  t.check(existsSync(imageNote), 'gorsel klasorundeki baska dosya kalir');
  t.check(!existsSync(tempOld) && !existsSync(tempEncOld), 'eski gecici yedek dosyalari silinir');
  t.check(existsSync(tempNew), 'yeni gecici dosya kalir (suren yedek olabilir)');
  t.check(!existsSync(stagingOld), 'kullanilmayan eski staging silinir');
  t.check(existsSync(stagingPending), 'bekleyen geri yuklemenin staging dosyasi kalir');
  t.check(existsSync(backupsNote), 'yedek klasorundeki baska dosya kalir');
  t.check(
    !existsSync(preRestore[0]) && !existsSync(preRestore[1]) && existsSync(preRestore[2]),
    'geri yukleme oncesi kopyalardan yalniz en yenisi kalir',
  );
  t.check(
    summary.deleted.images === 2 &&
      summary.deleted.tempFiles === 3 &&
      summary.deleted.preRestoreFiles === 2,
    `ozet: dosya sayilari (${summary.deleted.images}/${summary.deleted.tempFiles}/${summary.deleted.preRestoreFiles})`,
  );
  t.check(
    summary.freedBytes > 0 && summary.errors === 0,
    `bosalan alan, hata yok (${summary.errors})`,
  );

  // --- Ozet kaydi + ikinci calisma kararli ---
  const after = await backend.call('GET', '/storage');
  t.check(after.data.lastCleanup?.at === summary.at, 'son temizlik /storage da gorunur');
  const again = (await backend.call('POST', '/storage/cleanup')).data;
  const again0 = Object.values(again.deleted).every((n) => n === 0);
  t.check(again0, `ikinci temizlik bir sey silmez (${JSON.stringify(again.deleted)})`);

  // --- Yeni yedek: v2, parmak izi; veri degismeden ayni iz, degisince farkli ---
  const first = (await backend.call('POST', '/backups')).data;
  const second = (await backend.call('POST', '/backups')).data;
  t.check(first.format === 2 && second.format === 2, 'yeni yedekler bicim 2');
  t.check(
    /^[0-9a-f]{64}$/.test(first.fingerprint ?? '') && first.fingerprint === second.fingerprint,
    'veri degismeden iki yedegin parmak izi ayni',
  );
  t.check(
    first.cloudCopied === true && existsSync(join(cloudDir, first.path.split(/[\\/]/).pop())),
    'yeni yedek bulut klasorune kopyalandi',
  );
  // Teknik kayitlar ve gecici ayarlar izi degistirmez: oturum, fis/arka plan isi, bulut durumu
  // ve son temizlik bilgisi tek basina ertesi gunun otomatik yedegini tetiklemez.
  db.exec('PRAGMA busy_timeout = 5000');
  job('completed', 1);
  print('done', 1);
  op(1);
  session(1, -29);
  const upsertSetting = db.prepare(
    `INSERT INTO application_settings (id, branch_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, '{"e2e":true}', ?, ?)
     ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  for (const key of ['cloud.state', 'storage.lastCleanup', 'license.clock']) {
    upsertSetting.run(nextId('ST'), branchId, key, Date.now(), Date.now());
  }
  const technical = (await backend.call('POST', '/backups')).data;
  t.check(
    technical.fingerprint === second.fingerprint,
    'teknik kayitlar/gecici ayarlar izi degistirmez',
  );
  await backend.call('PUT', `/settings/${encodeURIComponent('backup.autoDaily')}`, {
    value: false,
  });
  const changed = (await backend.call('POST', '/backups')).data;
  t.check(changed.fingerprint !== second.fingerprint, 'isletme ayari degisince parmak izi degisir');
} finally {
  db.close();
  await backend.stop(child);
  rmSync(cloudDir, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
}
t.check(child.exitCode === 0, `duzgun kapanir (kod ${child.exitCode})`);
t.done();

// Bulut yedegi spawned e2e (backend 3031, sahte bulut 3997; ikisine de E2E_PORT_OFFSET eklenir).
// (a) buluta bagli kurulumda elle alinan yedek yuklenir (sha256 basligi dosyanin ozeti),
// (b) bulut once 503 doner -> geri cekilip yeniden denenir ve yuklenir,
// (d) buyuk yedek multipart yuklenir; kesilen yukleme kaldigi parcadan surer,
// (c) yeni bilgisayarda ilk kurulum ekranindan buluttan geri yukleme (kurtarma anahtariyla).
// Baglanti: imzali test lisansi + acilistan once SQLite'a yazilan `cloud.connection` ayari
// (ADO_INSTALL_ID ve adres ayni: acilis denetimi baglantiyi dusurmez).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildPayload, generateLicenseKeyPair, signLicense } from '../../../scripts/license.mjs';
import { startFakeBackupCloud } from './fake-backup-cloud.mjs';
import { checklist, portOffset, prepareBackend } from './spawn-backend.mjs';

const MB = 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function waitFor(read, accept, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return value;
}

/** Programin yazdigi ayar satiri (Prisma DateTime'i SQLite'ta epoch ms tutar). */
function insertSetting(db, branchId, key, value) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO application_settings (id, branch_id, key, value, created_at, updated_at, version,
       sync_state) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending')`,
  ).run(`e2e${randomBytes(10).toString('hex')}`, branchId, key, JSON.stringify(value), now, now);
}

function withDb(path, fn) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return fn(db);
  } finally {
    db.close();
  }
}

const t = checklist('Bulut yedegi (spawned)');
const cloudUrl = `http://127.0.0.1:${3997 + portOffset()}`;
const { privateKeyPem, publicKeyB64 } = generateLicenseKeyPair();
const licenseId = 'lic_bulut_yedek_e2e1';
const licenseKey = signLicense(
  buildPayload({
    id: licenseId,
    customer: 'Yedek Lokanta',
    exp: '2099-01-01',
    grace: 14,
    features: { 'qr.menu': true },
  }),
  privateKeyPem,
);
const posToken = `adoqr_pos_yedek_${randomBytes(12).toString('hex')}`;
const fake = await startFakeBackupCloud(cloudUrl, {
  publicKey: publicKeyB64,
  tokens: [[posToken, licenseId]],
});
const common = {
  CLOUD_API_URL: cloudUrl,
  ADO_LICENSE_PUBLIC_KEY: publicKeyB64,
  CLOUD_BACKUP_INTERVAL_SECONDS: '1',
};

try {
  // ===== Bilgisayar 1: buluta bagli, otomatik yukleme =====
  const installId = 'inst_yedek_e2e_0001';
  const pc1 = prepareBackend({
    name: 'cloudbackup',
    port: 3031,
    env: {
      ...common,
      ADO_INSTALL_ID: installId,
      // Multipart yolu kucuk veritabaniyla: 6 MB ustu yedek parca parca (5 MiB) gider.
      ADO_CLOUD_BACKUP_SINGLE_MAX_BYTES: String(6 * MB),
      CLOUD_BACKUP_PART_BYTES: String(5 * MB),
    },
  });
  const dbPath = pc1.env.DATABASE_URL.slice('file:'.length);
  const branchId = withDb(dbPath, (db) => {
    const branch = db
      .prepare('SELECT id, name FROM branches WHERE is_default = 1 AND deleted_at IS NULL')
      .get();
    insertSetting(db, branch.id, 'cloud.connection', {
      url: cloudUrl,
      token: posToken,
      installId,
      licenseId,
      branchId: 'bulut-sube-yedek',
      branchName: branch.name,
      tenantName: 'Yedek Lokanta',
      tenantStatus: 'active',
      planLabel: 'QR Menü',
      features: { 'qr.menu': true },
      licenseExpiresAt: '2099-01-15T00:00:00.000Z',
      pairedAt: new Date().toISOString(),
    });
    return branch.id;
  });

  let newest = null;
  const child1 = await pc1.start();
  try {
    await pc1.login();
    const status = async () => (await pc1.call('GET', '/cloud-backups/status')).data;
    const lic = await pc1.call('POST', '/license/activate', { licenseKey });
    t.check(lic.status < 300 && lic.data.licenseId === licenseId, `lisans etkin (${lic.status})`);
    const s0 = await status();
    t.check(
      s0.configured && s0.linked && s0.enabled && s0.switchedOn,
      'buluta bagli, bulut yedegi acik',
    );

    // (a) elle alinan yedek buluta gider
    const one = (await pc1.call('POST', '/backups')).data;
    const first = await waitFor(() => fake.state.backups.get(`${licenseId}/${one.id}`), Boolean);
    const put1 = fake.state.requests.find(
      (r) => r.posBackupId === one.id && r.kind === 'single' && r.status === 201,
    );
    const fileHash = sha256(readFileSync(one.path));
    t.check(Boolean(first), '(a) elle alinan yedek buluta yuklendi');
    t.check(
      put1?.headers['x-ado-sha256'] === fileHash && first?.meta.sha256 === fileHash,
      '(a) sha256 basligi dosyanin ozeti',
    );
    t.check(
      first?.meta.type === 'manual' && first?.meta.sizeBytes === one.sizeBytes,
      '(a) tur ve boyut',
    );
    const s1 = await waitFor(status, (s) => s.lastBackupId === one.id && !s.uploading);
    t.check(
      s1.pending === 0 &&
        s1.lastError === null &&
        s1.lastSizeBytes === one.sizeBytes &&
        Boolean(s1.lastUploadedAt),
      '(a) durum: son bulut yedegi, bekleyen yok',
    );

    // (b) bulut once 503: geri cekilip yeniden denenir
    fake.state.failNext = 1;
    const two = (await pc1.call('POST', '/backups')).data;
    const second = await waitFor(() => fake.state.backups.get(`${licenseId}/${two.id}`), Boolean);
    const tries = fake.state.requests.filter((r) => r.posBackupId === two.id).map((r) => r.status);
    t.check(
      Boolean(second) && tries[0] === 503 && tries.at(-1) === 201,
      `(b) 503 sonrasi yeniden denendi ve yuklendi (${tries.join(',')})`,
    );
    const s2 = await waitFor(status, (s) => s.lastBackupId === two.id);
    const row2 = withDb(dbPath, (db) =>
      db
        .prepare('SELECT status, attempts FROM cloud_backup_uploads WHERE backup_id = ?')
        .get(two.id),
    );
    t.check(
      s2.lastError === null && row2?.status === 'done' && row2?.attempts === 2,
      `(b) basaridan sonra hata temizlendi (deneme ${row2?.attempts})`,
    );

    // (d) buyuk yedek: multipart, 2. parca bir kez 503 -> kaldigi yerden
    withDb(dbPath, (db) =>
      insertSetting(db, branchId, 'e2e.dolgu', randomBytes(7 * MB).toString('base64')),
    );
    fake.state.failPart = { partNumber: 2, times: 1 };
    const three = (await pc1.call('POST', '/backups')).data;
    newest = three;
    t.check(three.sizeBytes > 6 * MB, `(d) buyuk yedek (${(three.sizeBytes / MB).toFixed(1)} MB)`);
    const big = await waitFor(
      () => fake.state.backups.get(`${licenseId}/${three.id}`),
      Boolean,
      60_000,
    );
    const mine = fake.state.requests.filter((r) => r.posBackupId === three.id);
    const parts = (n, code) =>
      mine.filter((r) => r.kind === 'part' && r.partNumber === n && r.status === code).length;
    t.check(
      Boolean(big) && sha256(big.bytes) === sha256(readFileSync(three.path)),
      '(d) multipart: buluttaki dosya yereldekiyle ayni',
    );
    t.check(
      mine.filter((r) => r.kind === 'create').length === 1 &&
        parts(1, 200) === 1 &&
        parts(2, 503) === 1 &&
        parts(2, 200) === 1,
      '(d) kesilen yukleme kaldigi parcadan surdu (1. parca yeniden gitmedi)',
    );

    // Yerel anahtar: kapaliyken "simdi yedekle" reddedilir
    const off = await pc1.call('PUT', '/cloud-backups/settings', { enabled: false });
    const offNow = await pc1.call('POST', '/cloud-backups/upload-now');
    t.check(
      off.data.switchedOn === false &&
        off.data.enabled === false &&
        offNow.status === 409 &&
        offNow.data?.error?.code === 'CLOUD_BACKUP_OFF',
      'yerel anahtar kapaliyken yukleme yok',
    );
    const on = await pc1.call('PUT', '/cloud-backups/settings', { enabled: true });
    const now1 = await pc1.call('POST', '/cloud-backups/upload-now');
    t.check(on.data.enabled === true && now1.status === 201, '"Simdi buluta yedekle" kabul edilir');

    const closed = await pc1.call('POST', '/cloud-backups/setup/list', { licenseKey });
    t.check(
      closed.status === 403 && closed.data?.error?.code === 'SETUP_ALREADY_DONE',
      'kullanici varken buluttan ilk kurulum kapali',
    );
  } finally {
    await pc1.stop(child1);
  }

  // ===== Bilgisayar 2: yeni kurulum, buluttan geri yukleme =====
  const pc2 = prepareBackend({
    name: 'cloudrestore',
    port: 3031,
    env: {
      ...common,
      ADO_INSTALL_ID: 'inst_yedek_e2e_0002',
      SEED_OWNER_PASSWORD: '',
      SEED_WAITER_PIN: '',
      BACKUP_ENCRYPTION_KEY: `yeni-bilgisayar-${randomBytes(16).toString('hex')}`,
    },
  });
  const child2 = await pc2.start();
  try {
    const setup = await pc2.call('GET', '/auth/setup-status');
    t.check(setup.data.required === true, '(c) yeni bilgisayar: ilk kurulum bekliyor');
    const list = await pc2.call('POST', '/cloud-backups/setup/list', { licenseKey });
    const backups = list.data.backups ?? [];
    t.check(
      list.status === 201 && backups.length === 3,
      `(c) lisansla buluttaki yedekler listelendi (${backups.length})`,
    );
    const target = backups[0];
    t.check(
      target?.posBackupId === newest?.id && !('downloadUrl' in (target ?? {})),
      '(c) en yeni once; indirme adresi ekrana verilmez',
    );
    const wrong = await pc2.call('POST', '/cloud-backups/setup/restore', {
      licenseKey,
      cloudBackupId: target?.id,
      recoveryKey: 'yanlis-kurtarma-anahtari-0123456789',
    });
    t.check(
      wrong.status === 400 && wrong.data?.error?.code === 'BACKUP_DECRYPT_FAILED',
      `(c) yanlis kurtarma anahtari reddedilir (${wrong.status})`,
    );
    const restored = await pc2.call('POST', '/cloud-backups/setup/restore', {
      licenseKey,
      cloudBackupId: target?.id,
      recoveryKey: pc1.env.BACKUP_ENCRYPTION_KEY,
    });
    t.check(
      restored.status === 201 && restored.data.staged === true && restored.data.keyAdopted === true,
      `(c) kurtarma anahtariyla geri yukleme hazirlandi (${restored.status})`,
    );
    t.check(fake.state.downloadCount === 1, '(c) ikinci denemede yedek yeniden indirilmedi');
    const marker = JSON.parse(readFileSync(join(pc2.dataDir, 'restore-pending.json'), 'utf8'));
    t.check(
      marker.backupKey === pc1.env.BACKUP_ENCRYPTION_KEY,
      '(c) isaret kurtarma anahtarini tasir (yeni bilgisayarda gecerli olur)',
    );
    const staged = new DatabaseSync(marker.stagePath, { readOnly: true });
    const users = staged.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const filler = staged
      .prepare("SELECT COUNT(*) AS n FROM application_settings WHERE key = 'e2e.dolgu'")
      .get().n;
    staged.close();
    t.check(users > 0 && filler === 1, '(c) geri yuklenen veritabani eski bilgisayarin verisi');

    const foreign = generateLicenseKeyPair();
    const bad = await pc2.call('POST', '/cloud-backups/setup/list', {
      licenseKey: signLicense(
        buildPayload({ id: licenseId, customer: 'Sahte', exp: '2099-01-01' }),
        foreign.privateKeyPem,
      ),
    });
    t.check(
      bad.status === 400 && bad.data?.error?.code === 'LICENSE_INVALID',
      '(c) baska anahtarla imzali lisans reddedilir',
    );
  } finally {
    await pc2.stop(child2);
  }
} finally {
  await fake.close();
}
t.done();

// Guncelleme onayi uctan uca: backend masaustu kabugu gibi IPC kanaliyla baslatilir (ts-node),
// kabugun durum mesajlari taklit edilir. Kendi veritabanini ve veri dizinini kurar.
// Kullanim: node test/updates.e2e.mjs (CI e2e isi; JWT/yedek anahtarlari ortamdan).
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const backendDir = resolve(import.meta.dirname, '..');
const repoRoot = resolve(backendDir, '..', '..');
// E2E_PORT_OFFSET: yerelde paralel kosularda portu kaydirir (CI'da bos = 0).
const PORT = 3021 + Number(process.env.E2E_PORT_OFFSET || 0);
const dataDir = mkdtempSync(join(tmpdir(), 'ado-updates-e2e-'));
const env = {
  ...process.env,
  DATABASE_URL: `file:${join(dataDir, 'updates.db')}`,
  ADO_DATA_DIR: dataDir,
  API_PORT: String(PORT),
  API_TLS_PORT: '',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'updates-e2e-access-secret-0123456789',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'updates-e2e-refresh-secret-0123456789',
  BACKUP_ENCRYPTION_KEY: process.env.BACKUP_ENCRYPTION_KEY || 'updates-e2e-backup-key-0123456789',
  SEED_OWNER_USERNAME: 'owner',
  SEED_OWNER_PASSWORD: 'owner1234',
  LOG_LEVEL: 'warn',
};
const pnpm = (...args) =>
  execFileSync('pnpm', args, { cwd: repoRoot, env, stdio: ['ignore', 'ignore', 'inherit'] });
pnpm('exec', 'prisma', 'migrate', 'deploy');
pnpm('--filter', '@ado/backend', 'run', 'seed');

const tsNode = createRequire(join(backendDir, 'package.json')).resolve('ts-node/dist/bin.js');
const messages = [];

async function startBackend(appVersion) {
  const child = spawn(process.execPath, [tsNode, '--transpile-only', 'src/main.ts'], {
    cwd: backendDir,
    env: { ...env, ADO_APP_VERSION: appVersion },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  child.on('message', (message) => messages.push(message));
  for (let i = 0; i < 120; i++) {
    const up = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`)
      .then((res) => res.ok)
      .catch(() => false);
    if (up) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('backend acilmadi');
}

async function stopBackend(child) {
  const exited = new Promise((r) => child.once('exit', r));
  child.send({ type: 'shutdown' });
  await exited;
}

let token = '';
async function call(method, path, body, host = '127.0.0.1') {
  const res = await fetch(`http://${host}:${PORT}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data ?? json };
}
const status = async () => (await call('GET', '/updates/status')).data;
const desktopStatus = (patch) => ({
  type: 'update-status',
  state: 'idle',
  channel: 'stable',
  currentVersion: '0.3.0',
  version: null,
  checkedAt: new Date().toISOString(),
  ...patch,
});
const waitFor = async (read, accept, ms = 5000) => {
  const end = Date.now() + ms;
  let value = await read();
  while (!accept(value) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
};

const ok = [];
const check = (cond, label) => {
  assert.ok(cond, label);
  ok.push(label);
  console.log(`  ✓ ${label}`);
};

const backend = await startBackend('0.3.0');
try {
  const login = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'owner1234' }),
  }).then((res) => res.json());
  token = login.data.accessToken;

  check((await status()).available === false, 'kabuk durum bildirmeden kart gorunmez');
  const noCheck = await call('POST', '/updates/check');
  check(noCheck.status === 409, `kapaliyken denetim istenemez (${noCheck.status})`);

  backend.send(desktopStatus({ state: 'disabled' }));
  check(
    (await waitFor(status, (s) => s.state === 'disabled')).available === false,
    'anahtarsiz kurulumda kart gorunmez',
  );

  backend.send(desktopStatus({ state: 'idle' }));
  const idle = await waitFor(status, (s) => s.available);
  check(
    idle.available && idle.currentVersion === '0.3.0' && !idle.canInstall,
    'kabuk bildirince kart gorunur',
  );
  const asked = await call('POST', '/updates/check');
  const checkMessage = await waitFor(
    () => messages.find((m) => m.type === 'update-check'),
    Boolean,
  );
  check(asked.status < 400 && Boolean(checkMessage), 'simdi kontrol et kabuga iletilir');

  backend.send(
    desktopStatus({ state: 'ready', version: '0.3.1', notes: 'Duzeltmeler', progress: 100 }),
  );
  await waitFor(status, (s) => s.state === 'ready');
  const open = await call('POST', '/cash/sessions/open', { openingFloat: 0 });
  check(open.status < 400, 'kasa acildi');
  const blocked = await status();
  check(
    blocked.blockers.some((b) => b.code === 'CASH_OPEN') && !blocked.canInstall,
    'acik kasa kurulumu engeller',
  );
  const refused = await call('POST', '/updates/approve', { version: '0.3.1' });
  check(
    refused.status === 409 && refused.data.error?.code === 'UPDATE_BLOCKED',
    `acik kasayla onay reddedilir (${refused.status})`,
  );
  const wrong = await call('POST', '/updates/approve', { version: '0.3.2' });
  check(wrong.data.error?.code === 'UPDATE_NOT_READY', 'hazir olmayan surum onaylanamaz');

  // Tablet (LAN adresi) onay veremez.
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (lan) {
    const remote = (await call('GET', '/updates/status', undefined, lan)).data;
    check(
      remote.blockers.some((b) => b.code === 'NOT_LOCAL'),
      `tabletten (${lan}) onay verilemez`,
    );
  }

  const closed = await call('POST', '/cash/sessions/close', { countedAmount: 0 });
  check(closed.status < 400, 'kasa kapatildi');
  const ready = await status();
  check(ready.canInstall && ready.blockers.length === 0, 'engel kalmayinca kurulabilir');
  const approved = await call('POST', '/updates/approve', { version: '0.3.1' });
  const install = await waitFor(() => messages.find((m) => m.type === 'update-install'), Boolean);
  check(
    approved.status < 400 && approved.data.state === 'installing' && install?.version === '0.3.1',
    `onay kabuga "kur" komutu yollar (${approved.status})`,
  );
  const backups = (await call('GET', '/backups')).data;
  check(
    Array.isArray(backups) && backups.some((b) => b.type === 'pre_update'),
    'kurulumdan once yedek alindi',
  );
  const again = await call('POST', '/updates/approve', { version: '0.3.1' });
  check(again.status === 409, 'kurulum basladiktan sonra ikinci onay yok');
} finally {
  await stopBackend(backend);
}

// Program yeni surumle acildi: gecmis "kuruldu" olur.
const restarted = await startBackend('0.3.1');
try {
  const after = await status();
  check(
    after.lastUpdate?.status === 'applied' && after.lastUpdate.toVersion === '0.3.1',
    'yeni surumle acilinca kurulum "kuruldu" yazilir',
  );
} finally {
  await stopBackend(restarted);
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\nGUNCELLEME E2E: ${ok.length} gecti`);

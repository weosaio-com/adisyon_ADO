// Bulut baglantisi (spawned; kendi portu 3071, sahte bulut 3079): lisansla kendiliginden baglanma,
// heartbeat araligi (1 sn), QR kapaliyken bulutta kalan menunun kaldirilmasi, eski bulut (heartbeat
// ve unpublish yok), 0.3.0'dan yukseltme (QR menu acik kalir, lisans bir kez bildirilir) ve
// license.remote olayi. Anahtar cifti her kosumda bellekte uretilir (dosyaya yazilmaz).
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { buildPayload, generateLicenseKeyPair, signLicense } from '../../../scripts/license.mjs';
import { startFakeCloud } from './fake-cloud.mjs';
import { checklist, portOffset, prepareBackend } from './spawn-backend.mjs';

const t = checklist('Bulut baglantisi (spawned)');
const keys = generateLicenseKeyPair();
const cloudUrl = `http://127.0.0.1:${3079 + portOffset()}`;
const license = (overrides = {}) =>
  signLicense(
    buildPayload({
      id: 'lic_spawn_0001',
      customer: 'Spawn Lokanta',
      exp: '2099-01-01',
      features: { 'qr.menu': true },
      ...overrides,
    }),
    keys.privateKeyPem,
  );

async function waitFor(read, accept, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return value;
}

const fake = await startFakeCloud(cloudUrl, keys.publicKeyB64);
const backend = prepareBackend({
  name: 'cloud-link',
  port: 3071,
  env: {
    CLOUD_API_URL: cloudUrl,
    CLOUD_RECONCILE_SECONDS: '1',
    CLOUD_HEARTBEAT_SECONDS: '1',
    ADO_LICENSE_PUBLIC_KEY: keys.publicKeyB64,
  },
});
let child = await backend.start();
try {
  await backend.login();
  const status = async () => (await backend.call('GET', '/cloud/status')).data;

  // Lisans girilince kendiliginden baglanir; heartbeat araliginda tekrarlanir.
  await backend.call('POST', '/license/activate', { licenseKey: license() });
  const linked = await waitFor(status, (s) => s.link === 'linked');
  t.check(
    linked.link === 'linked' && fake.state.activations.length === 1,
    `lisansla kendiliginden baglanir (${linked.link})`,
  );
  const beats = await waitFor(
    () => fake.state.heartbeats.length,
    (n) => n >= 3,
  );
  t.check(beats >= 3, `heartbeat araliginda tekrarlanir (${beats})`);
  t.check(linked.qr === 'off' && fake.state.menus.length === 0, 'QR menu acilmadan menu gitmez');

  // QR kapaliyken bulutta menu kalmissa (or. yedekten donus) heartbeat'te kaldirilir.
  fake.state.version = 7;
  const cleaned = await waitFor(
    () => fake.state.unpublished,
    (n) => n >= 1,
  );
  t.check(cleaned === 1 && fake.state.version === 0, 'QR kapaliyken bulutta kalan menu kaldirilir');

  // Eski bulut (heartbeat ve unpublish yok): durum /status'tan okunur; kapatma masa listesini bosaltir.
  const { data: hall } = await backend.call('POST', '/halls', { name: 'Spawn Salon' });
  await backend.call('POST', '/tables', { hallId: hall.id, name: 'Spawn Masa' });
  fake.state.noHeartbeat = true;
  const beatsBefore = fake.state.heartbeats.length;
  const seenBefore = (await status()).lastHeartbeatAt;
  const fallback = await waitFor(status, (s) => s.lastHeartbeatAt !== seenBefore);
  t.check(
    fallback.lastHeartbeatAt !== seenBefore &&
      fallback.link === 'linked' &&
      fake.state.heartbeats.length === beatsBefore,
    'eski bulutta heartbeat yerine durum okunur',
  );
  await backend.call('PUT', '/cloud/qr', { enabled: true });
  const published = await waitFor(
    () => fake.state.tables.length,
    (n) => n >= 1,
  );
  t.check(published >= 1, 'eski bulutta QR menu yayinlanir');
  await waitFor(status, (s) => !s.publishing);
  const { data: off } = await backend.call('PUT', '/cloud/qr', { enabled: false });
  t.check(
    off.qr === 'off' &&
      !off.unpublishPending &&
      fake.state.tables.length === 0 &&
      fake.state.unpublished === cleaned,
    'eski bulutta kapatma masa listesini bosaltir (baglanti kalir)',
  );
  fake.state.noHeartbeat = false;

  // 0.3.0'dan yukseltme: baglanti var, QR ayari yok -> QR menu acik kalir, lisans bir kez bildirilir.
  await backend.stop(child);
  const db = new DatabaseSync(join(backend.dataDir, 'cloud-link.db'));
  db.prepare("DELETE FROM application_settings WHERE key = 'cloud.qrPublish'").run();
  db.close();
  const licensesBefore = fake.state.licenses.length;
  const menusBefore = fake.state.menus.length;
  child = await backend.start();
  await backend.login();
  const upgraded = await waitFor(
    status,
    (s) => s.qrPublish && s.lastMenuVersion >= 1 && fake.state.licenses.length > licensesBefore,
    15000,
  );
  t.check(
    upgraded.qr === 'on' &&
      upgraded.link === 'linked' &&
      fake.state.licenses.length > licensesBefore &&
      fake.state.menus.length > menusBefore &&
      fake.state.activations.length === 1,
    `yukseltmede QR menu acik kalir, lisans bildirilir, yeniden baglanmaz (${upgraded.qr})`,
  );

  // Heartbeat yaniti license.remote olayina doner (SSE yalniz adini tasir; anahtar sizmaz).
  const token = await backend.login();
  const sse = await fetch(`${backend.base}/events/stream`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
  });
  const reader = sse.body.getReader();
  fake.state.remote.update = license({ exp: '2099-06-01' });
  const message = await Promise.race([
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return buf;
        buf += dec.decode(value, { stream: true });
        if (buf.includes('license.remote')) return buf;
      }
    })(),
    new Promise((resolve) => setTimeout(() => resolve(''), 8000)),
  ]);
  await reader.cancel().catch(() => {});
  fake.state.remote.update = null;
  t.check(
    message.includes('license.remote') && !message.includes('ADO1.'),
    'heartbeat license.remote olayini yayinlar (anahtar olay akisina girmez)',
  );
} finally {
  await backend.stop(child);
  fake.close();
}
t.check(child.exitCode === 0, `duzgun kapanir (kod ${child.exitCode})`);
t.done();

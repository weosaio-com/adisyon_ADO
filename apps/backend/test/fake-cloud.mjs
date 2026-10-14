// QR menu bulutunun POS API'sini taklit eden sahte sunucu (apps/cloud src/routes/pos.ts ile ayni
// sozlesme). Smoke ve "spawned" e2e testleri ortak kullanir. Durum `state` uzerinden yonetilir
// (or. state.unavailable = true -> internet yok gibi davranir).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { verifyLicense } from '../../../scripts/license.mjs';

// QR menu bulutunun POS API'sini taklit eder (apps/cloud src/routes/pos.ts ile ayni sozlesme).
// CLOUD_API_URL'deki portta dinler: POS bulut adresini acilista okur (programa gomulu).
export async function startFakeCloud(cloudUrl, publicKey) {
  const state = {
    token: null,
    activations: [],
    licenses: [],
    menus: [],
    tables: [],
    images: new Map(),
    unpaired: 0,
    failMenu: 0,
    version: 0,
    unavailable: false, // tum istekler 503 (gecici hata; "internet yok" gibi davranir)
    suspended: false, // isletme askida: yayin 403, durum suspended
    revoke: null, // belirtecli uclarda 401 kodu (or. POS_TOKEN_SUPERSEDED)
    otherInstall: null, // lisans baska kurulumda acik (409 ACTIVE_ON_OTHER_INSTALL)
    expiresAt: '2099-01-15T00:00:00.000Z',
  };
  let seq = 0;
  const info = () => ({
    branch: { id: 'bulut-sube-1', name: 'Smoke Lokanta' },
    tenant: {
      name: 'Smoke Lokanta',
      status: state.suspended ? 'suspended' : 'active',
      plan: 'menu',
      planLabel: 'QR Menü',
      features: { 'qr.menu': !state.suspended },
    },
    license: { id: 'lic_smoke_0001', expiresAt: state.expiresAt },
  });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ok = (data, status = 200) => send(status, { success: true, data });
    const fail = (status, code, message, details) =>
      send(status, { success: false, error: { code, message, ...(details ? { details } : {}) } });
    const path = new URL(req.url, 'http://fake').pathname;
    if (state.unavailable) return fail(503, 'UNAVAILABLE', 'Bulut bakımda.');
    if (req.method === 'POST' && path === '/api/pos/activate') {
      const body = JSON.parse(raw.toString());
      if (!verifyLicense(body.licenseKey, publicKey)) {
        return fail(400, 'LICENSE_INVALID', 'Lisans anahtarı geçersiz ya da bozuk.');
      }
      if (state.otherInstall && state.otherInstall !== body.installId && !body.takeover) {
        return fail(
          409,
          'ACTIVE_ON_OTHER_INSTALL',
          'Bu lisansla QR menü başka bir bilgisayarda açık.',
          {
            lastSeenAt: new Date().toISOString(),
          },
        );
      }
      state.otherInstall = null;
      state.token = `adoqr_pos_smoke_${++seq}`;
      state.activations.push(body);
      return ok({ token: state.token, ...info() }, 201);
    }
    if (!state.token || req.headers.authorization !== `Bearer ${state.token}`) {
      return fail(401, 'POS_TOKEN_INVALID', 'POS bağlantısı geçersiz.');
    }
    if (state.revoke)
      return fail(401, state.revoke, 'Bu lisansla QR menü başka bir bilgisayarda açıldı.');
    if (req.method === 'GET' && path === '/api/pos/status') {
      return ok({ ...info(), menu: { version: state.version }, tableCount: state.tables.length });
    }
    if (req.method === 'PUT' && path === '/api/pos/license') {
      const payload = verifyLicense(JSON.parse(raw.toString()).licenseKey, publicKey);
      if (!payload) return fail(400, 'LICENSE_INVALID', 'Lisans anahtarı geçersiz ya da bozuk.');
      state.licenses.push(payload);
      return ok(info());
    }
    if (state.suspended && /^\/api\/pos\/(menu|tables|images)/.test(path)) {
      return fail(403, 'TENANT_SUSPENDED', 'İşletmenin QR menüsü askıya alınmış.');
    }
    if (req.method === 'POST' && path === '/api/pos/images/check') {
      const { keys } = JSON.parse(raw.toString());
      return ok({ missing: keys.filter((key) => !state.images.has(key)) });
    }
    if (req.method === 'PUT' && path.startsWith('/api/pos/images/')) {
      const key = path.slice('/api/pos/images/'.length);
      const ext = key.slice(key.lastIndexOf('.'));
      if (createHash('sha256').update(raw).digest('hex') + ext !== key) {
        return fail(400, 'IMAGE_KEY_MISMATCH', 'Görsel içeriği anahtarla eşleşmiyor.');
      }
      state.images.set(key, raw);
      return ok({ key }, 201);
    }
    if (req.method === 'PUT' && path === '/api/pos/menu') {
      if (state.failMenu > 0) {
        state.failMenu--;
        return fail(503, 'UNAVAILABLE', 'Bulut bakımda.');
      }
      state.menus.push(JSON.parse(raw.toString()));
      return ok({ version: ++state.version, updatedAt: new Date().toISOString() });
    }
    if (req.method === 'PUT' && path === '/api/pos/tables') {
      state.tables = JSON.parse(raw.toString()).tables;
      return ok({ count: state.tables.length });
    }
    if (req.method === 'POST' && path === '/api/pos/unpair') {
      state.unpaired++;
      state.token = null;
      return ok({ unpaired: true });
    }
    return fail(404, 'NOT_FOUND', 'Kaynak bulunamadı.');
  });
  const { hostname, port } = new URL(cloudUrl);
  await new Promise((resolve) => server.listen(Number(port), hostname, resolve));
  return { state, close: () => server.close() };
}

// QR menu bulutunun POS API'sini taklit eden sahte sunucu (apps/cloud src/routes/pos.ts ile ayni
// sozlesme). Smoke ve "spawned" e2e testleri ortak kullanir. Durum `state` uzerinden yonetilir
// (or. state.unavailable = true -> internet yok gibi davranir).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { heartbeatRequestSchema } from '@ado/shared';
import { verifyLicense } from '../../../scripts/license.mjs';

// CLOUD_API_URL'deki portta dinler: POS bulut adresini acilista okur (programa gomulu).
export async function startFakeCloud(cloudUrl, publicKey) {
  const state = {
    token: null,
    activations: [],
    /** PUT /api/pos/license ile gelen lisans payload'lari (yenileme). */
    licenses: [],
    /** Son kabul edilen lisans payload'i (baglanma ya da yenileme): kimlik ve ozellikler buradan. */
    payload: null,
    menus: [],
    tables: [],
    images: new Map(),
    unpaired: 0,
    /** POST /api/pos/menu/unpublish sayisi (baglanti kalir). */
    unpublished: 0,
    /** Heartbeat govdeleri (sozlesmeye uymayan 422 alir, buraya girmez). */
    heartbeats: [],
    failMenu: 0,
    version: 0,
    unavailable: false, // tum istekler 503 (gecici hata; "internet yok" gibi davranir)
    suspended: false, // isletme askida: yayin 403, uzak durum suspended
    licenseRevoked: false, // lisans iptal: baglanma/yenileme/yayin 403 LICENSE_REVOKED, uzak durum revoked
    revoke: null, // belirtecli uclarda 401 kodu (or. POS_TOKEN_SUPERSEDED)
    otherInstall: null, // lisans baska kurulumda bagli (409 ACTIVE_ON_OTHER_INSTALL)
    noHeartbeat: false, // eski bulut: heartbeat ve unpublish 404 (POS /status'a ve masa listesine duser)
    remote: { update: null }, // heartbeat yanitindaki yeni lisans anahtari (remote.update)
    expiresAt: '2099-01-15T00:00:00.000Z',
  };
  let seq = 0;
  const qrMenu = () => !state.suspended && state.payload?.f?.['qr.menu'] === true;
  const remoteState = () =>
    state.licenseRevoked
      ? 'revoked'
      : state.suspended
        ? 'suspended'
        : state.expiresAt <= new Date().toISOString()
          ? 'expired'
          : 'active';
  const info = () => ({
    branch: { id: 'bulut-sube-1', name: 'Smoke Lokanta' },
    tenant: {
      name: 'Smoke Lokanta',
      status: state.suspended ? 'suspended' : 'active',
      plan: qrMenu() ? 'menu' : 'none',
      planLabel: qrMenu() ? 'QR Menü' : 'none',
      features: { ...(state.payload?.f ?? {}), 'qr.menu': qrMenu() },
    },
    license: { id: state.payload?.id ?? 'lic_smoke_0001', expiresAt: state.expiresAt },
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
    const revoked = () => fail(403, 'LICENSE_REVOKED', 'Bu lisans satıcı tarafından iptal edildi.');
    const path = new URL(req.url, 'http://fake').pathname;
    if (state.unavailable) return fail(503, 'UNAVAILABLE', 'Bulut bakımda.');
    if (req.method === 'POST' && path === '/api/pos/activate') {
      const body = JSON.parse(raw.toString());
      const payload = verifyLicense(body.licenseKey, publicKey);
      if (!payload) return fail(400, 'LICENSE_INVALID', 'Lisans anahtarı geçersiz ya da bozuk.');
      if (state.licenseRevoked) return revoked();
      if (state.otherInstall && state.otherInstall !== body.installId && !body.takeover) {
        return fail(
          409,
          'ACTIVE_ON_OTHER_INSTALL',
          'Bu lisans başka bir bilgisayarda buluta bağlı.',
          {
            lastSeenAt: new Date().toISOString(),
          },
        );
      }
      state.otherInstall = null;
      state.token = `adoqr_pos_smoke_${++seq}`;
      state.activations.push(body);
      state.payload = payload;
      return ok({ token: state.token, ...info() }, 201);
    }
    if (!state.token || req.headers.authorization !== `Bearer ${state.token}`) {
      return fail(401, 'POS_TOKEN_INVALID', 'POS bağlantısı geçersiz.');
    }
    if (state.revoke) return fail(401, state.revoke, 'Bulut bağlantısı geçersiz kılındı.');
    if (req.method === 'GET' && path === '/api/pos/status') {
      return ok({
        ...info(),
        menu: state.version ? { version: state.version } : null,
        tableCount: state.tables.length,
      });
    }
    if (req.method === 'POST' && path === '/api/pos/heartbeat' && !state.noHeartbeat) {
      const parsed = heartbeatRequestSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return fail(422, 'VALIDATION_ERROR', 'Doğrulama hatası.');
      state.heartbeats.push(parsed.data);
      const remote = remoteState();
      return ok({
        ...info(),
        remote: {
          state: remote,
          ...(state.remote.update && remote !== 'revoked' ? { update: state.remote.update } : {}),
        },
        serverTime: new Date().toISOString(),
        menu: state.version
          ? { version: state.version, updatedAt: new Date().toISOString() }
          : null,
      });
    }
    if (req.method === 'PUT' && path === '/api/pos/license') {
      const payload = verifyLicense(JSON.parse(raw.toString()).licenseKey, publicKey);
      if (!payload) return fail(400, 'LICENSE_INVALID', 'Lisans anahtarı geçersiz ya da bozuk.');
      if (state.licenseRevoked) return revoked();
      state.licenses.push(payload);
      state.payload = payload;
      return ok(info());
    }
    if (req.method === 'POST' && path === '/api/pos/menu/unpublish' && !state.noHeartbeat) {
      state.unpublished++;
      state.version = 0;
      state.tables = [];
      return ok({ unpublished: true });
    }
    if (/^\/api\/pos\/(menu|tables|images)/.test(path) && path !== '/api/pos/menu/unpublish') {
      if (state.licenseRevoked) return revoked();
      if (state.suspended) return fail(403, 'TENANT_SUSPENDED', 'İşletme askıya alınmış.');
      if (!qrMenu()) return fail(403, 'QR_MENU_NOT_LICENSED', 'Lisansınız QR menüyü içermiyor.');
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

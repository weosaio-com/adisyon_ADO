import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { licensePublicKeys, verifyLicense } from '../src/lib/license';
import fixture from './fixtures/license-fixture.json';
import {
  activate,
  call,
  licensePayload,
  sampleMenu,
  sha256Hex,
  signLicense,
  unique,
} from './helpers';

const tokenHash = (token: string) => sha256Hex(new TextEncoder().encode(token));

describe('lisans dogrulamasi', () => {
  it("Node araciyla (scripts/license.mjs) imzalanan lisans Worker'da dogrulanir", async () => {
    expect(await verifyLicense(fixture.licenseKey, [fixture.publicKey])).toEqual(fixture.payload);
    // Baska anahtarla dogrulanmaz; listedeki bozuk anahtar atlanir.
    expect(await verifyLicense(fixture.licenseKey, [env.LICENSE_PUBLIC_KEY ?? ''])).toBeNull();
    expect(await verifyLicense(fixture.licenseKey, ['bozuk', fixture.publicKey])).toEqual(
      fixture.payload,
    );
  });

  it('acik anahtar yoksa lisansla baglanma kapali (503)', () => {
    expect(() => licensePublicKeys({ LICENSE_PUBLIC_KEY: ' , ' })).toThrow(
      expect.objectContaining({ status: 503, code: 'ACTIVATION_DISABLED' }),
    );
    expect(licensePublicKeys({ LICENSE_PUBLIC_KEY: 'a, b' })).toEqual(['a', 'b']);
  });
});

describe('POS lisansla etkinlestirme', () => {
  it('isletmeyi lisans kimligiyle acar, belirteci yalniz ozetiyle saklar', async () => {
    const payload = licensePayload({ c: 'Deneme Lokantası' });
    const installId = unique('inst');
    const res = await activate({
      licenseKey: await signLicense(payload),
      installId,
      headers: { 'X-Ado-Version': '0.3.0' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.token).toMatch(/^adoqr_pos_/);
    expect(res.body.data.tenant).toMatchObject({ name: 'Deneme Lokantası', status: 'active' });
    expect(res.body.data.tenant.features['qr.menu']).toBe(true);
    expect(res.body.data.tenant.features['qr.order']).toBe(false);
    // exp 2099-01-01 + 14 gun ek sure (UTC).
    expect(res.body.data.license).toEqual({
      id: payload.id,
      expiresAt: '2099-01-15T00:00:00.000Z',
    });

    const branch = await env.DB.prepare(
      `SELECT b.source, b.install_id, b.pos_app_version, b.pos_token_hash, t.license_id
       FROM branches b JOIN tenants t ON t.id = b.tenant_id WHERE b.id = ?`,
    )
      .bind(res.body.data.branch.id)
      .first<Record<string, string>>();
    expect(branch).toMatchObject({
      source: 'pos',
      install_id: installId,
      pos_app_version: '0.3.0',
      license_id: payload.id,
      pos_token_hash: await tokenHash(res.body.data.token),
    });

    const status = await call('GET', '/api/pos/status', { token: res.body.data.token });
    expect(status.status).toBe(200);
    expect(status.body.data.license.id).toBe(payload.id);
    expect(status.body.data.menu).toBeNull();
  });

  it('ayni kurulum yeniden baglaninca belirtec yenilenir; eskisi ROTATED', async () => {
    const licenseKey = await signLicense(licensePayload());
    const installId = unique('inst');
    const first = await activate({ licenseKey, installId });
    const second = await activate({ licenseKey, installId });
    expect(second.status).toBe(201);
    expect(second.body.data.token).not.toBe(first.body.data.token);
    expect(second.body.data.branch.id).toBe(first.body.data.branch.id);

    const old = await call('GET', '/api/pos/status', { token: first.body.data.token });
    expect(old.status).toBe(401);
    expect(old.body.error?.code).toBe('POS_TOKEN_ROTATED');
    expect((await call('GET', '/api/pos/status', { token: second.body.data.token })).status).toBe(
      200,
    );
  });

  it('baska kurulum ancak onayla devralir; eski belirtec SUPERSEDED', async () => {
    const licenseKey = await signLicense(licensePayload());
    const first = await activate({ licenseKey, installId: unique('inst') });
    const other = unique('inst');

    const conflict = await activate({ licenseKey, installId: other });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('ACTIVE_ON_OTHER_INSTALL');
    expect(conflict.body.error?.details).toEqual({ lastSeenAt: expect.any(String) });
    // Onaysiz deneme ilk kurulumu bozmaz.
    expect((await call('GET', '/api/pos/status', { token: first.body.data.token })).status).toBe(
      200,
    );

    const takeover = await activate({ licenseKey, installId: other, takeover: true });
    expect(takeover.status).toBe(201);
    const old = await call('GET', '/api/pos/status', { token: first.body.data.token });
    expect(old.body.error?.code).toBe('POS_TOKEN_SUPERSEDED');
  });

  it('kapatilmis baglanti onay istemeden baska kurulumda acilir', async () => {
    const licenseKey = await signLicense(licensePayload());
    const first = await activate({ licenseKey, installId: unique('inst') });
    await call('POST', '/api/pos/unpair', { token: first.body.data.token });
    expect((await activate({ licenseKey, installId: unique('inst') })).status).toBe(201);
  });

  it('gecersiz, kimliksiz, suresi dolmus ya da QR menusuz lisans reddedilir', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
    );
    const foreign = btoa(String.fromCharCode(...pkcs8));
    const cases: Array<[string, number, string]> = [
      [await signLicense(licensePayload(), foreign), 400, 'LICENSE_INVALID'],
      ['ADO1.bozuk.anahtar-ama-yeterince-uzun', 400, 'LICENSE_INVALID'],
      [await signLicense(licensePayload({ id: undefined })), 400, 'LICENSE_ID_REQUIRED'],
      [await signLicense(licensePayload({ exp: '2020-01-01', g: 0 })), 403, 'LICENSE_EXPIRED'],
      [await signLicense(licensePayload({ f: { 'qr.menu': false } })), 403, 'QR_MENU_NOT_LICENSED'],
      [await signLicense(licensePayload({ f: undefined })), 403, 'QR_MENU_NOT_LICENSED'],
    ];
    for (const [licenseKey, status, code] of cases) {
      const res = await activate({ licenseKey });
      expect([res.status, res.body.error?.code]).toEqual([status, code]);
    }
    const badInstall = await call('POST', '/api/pos/activate', {
      json: { licenseKey: await signLicense(licensePayload()), installId: 'kisa' },
      ip: unique('ip'),
    });
    expect(badInstall.status).toBe(422);
  });

  it('askiya alinan isletme etkinlestirilemez', async () => {
    const licenseKey = await signLicense(licensePayload());
    const first = await activate({ licenseKey });
    const tenantId = await tenantIdOf(first.body.data.branch.id);
    await call('PATCH', `/api/admin/tenants/${tenantId}`, {
      admin: true,
      json: { status: 'suspended' },
    });
    const res = await activate({ licenseKey });
    expect([res.status, res.body.error?.code]).toEqual([403, 'TENANT_SUSPENDED']);
  });

  it("ayni IP'den denemeler sinirlanir", async () => {
    const ip = unique('ip');
    for (let i = 0; i < 10; i++) await activate({ licenseKey: 'ADO1.x.yeterince-uzun-deneme', ip });
    const limited = await activate({ ip });
    expect(limited.status).toBe(429);
  });
});

async function tenantIdOf(branchId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT tenant_id FROM branches WHERE id = ?')
    .bind(branchId)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? '';
}

describe('lisans yenileme ve durum', () => {
  it('ayni kimlikli yeni lisans belirteci degistirmeden sureyi uzatir', async () => {
    const payload = licensePayload({ exp: '2098-01-01' });
    const { body } = await activate({ licenseKey: await signLicense(payload) });
    const token = body.data.token;

    const renewed = await call('PUT', '/api/pos/license', {
      token,
      json: { licenseKey: await signLicense({ ...payload, exp: '2099-06-01', c: 'Yeni Ad' }) },
    });
    expect(renewed.status).toBe(200);
    expect(renewed.body.data.license.expiresAt).toBe('2099-06-15T00:00:00.000Z');
    expect(renewed.body.data.tenant.name).toBe('Yeni Ad');
    expect((await call('GET', '/api/pos/status', { token })).status).toBe(200);

    const mismatch = await call('PUT', '/api/pos/license', {
      token,
      json: { licenseKey: await signLicense(licensePayload()) },
    });
    expect([mismatch.status, mismatch.body.error?.code]).toEqual([409, 'LICENSE_ID_MISMATCH']);
  });

  it('QR menusuz yenileme ozelligi kapatir: yayin 403, musteri sayfasi kapali', async () => {
    const payload = licensePayload();
    const { body } = await activate({ licenseKey: await signLicense(payload) });
    const token = body.data.token;
    await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    await call('PUT', '/api/pos/tables', {
      token,
      json: { tables: [{ code: 'YENILEMEAAAAAAA2', name: 'Masa 1' }] },
    });
    expect((await call('GET', '/api/m/YENILEMEAAAAAAA2')).status).toBe(200);

    const renewed = await call('PUT', '/api/pos/license', {
      token,
      json: { licenseKey: await signLicense({ ...payload, f: {} }) },
    });
    expect(renewed.body.data.tenant.features['qr.menu']).toBe(false);
    const publish = await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    expect([publish.status, publish.body.error?.code]).toEqual([403, 'QR_MENU_NOT_LICENSED']);
    expect((await call('GET', '/api/m/YENILEMEAAAAAAA2')).body.error?.code).toBe('MENU_DISABLED');
  });

  it('askida isletmede yayin 403, durum okunur; dolan lisans menuyu kapatir', async () => {
    const { body } = await activate();
    const token = body.data.token;
    const tenantId = await tenantIdOf(body.data.branch.id);
    await call('PUT', '/api/pos/tables', {
      token,
      json: { tables: [{ code: 'ASKIKODUAAAAAAA2', name: 'Masa 1' }] },
    });
    await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });

    await call('PATCH', `/api/admin/tenants/${tenantId}`, {
      admin: true,
      json: { status: 'suspended' },
    });
    const publish = await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    expect([publish.status, publish.body.error?.code]).toEqual([403, 'TENANT_SUSPENDED']);
    const status = await call('GET', '/api/pos/status', { token });
    expect([status.status, status.body.data.tenant.status]).toEqual([200, 'suspended']);

    await call('PATCH', `/api/admin/tenants/${tenantId}`, {
      admin: true,
      json: { status: 'active' },
    });
    await env.DB.prepare('UPDATE tenants SET license_expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), tenantId)
      .run();
    const expired = await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    expect([expired.status, expired.body.error?.code]).toEqual([403, 'LICENSE_EXPIRED']);
    expect((await call('GET', '/api/m/ASKIKODUAAAAAAA2')).body.error?.code).toBe('MENU_DISABLED');
  });
});

describe('QR menuyu kapatma ve satici islemleri', () => {
  it('kapatinca menu ve masalar yayindan kalkar, belirtec UNPAIRED', async () => {
    const { body } = await activate();
    const token = body.data.token;
    await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    await call('PUT', '/api/pos/tables', {
      token,
      json: { tables: [{ code: 'KAPATKODUAAAAAA2', name: 'Masa 1' }] },
    });
    expect((await call('GET', '/api/m/KAPATKODUAAAAAA2')).status).toBe(200);

    expect((await call('POST', '/api/pos/unpair', { token })).status).toBe(200);
    expect((await call('GET', '/api/m/KAPATKODUAAAAAA2')).body.error?.code).toBe('TABLE_NOT_FOUND');
    const after = await call('GET', '/api/pos/status', { token });
    expect([after.status, after.body.error?.code]).toEqual([401, 'POS_TOKEN_UNPAIRED']);
  });

  it('satici baglantiyi kaldirir (REVOKED) ve isletmeyi silebilir', async () => {
    const { body } = await activate();
    const tenantId = await tenantIdOf(body.data.branch.id);

    const view = await call('GET', `/api/admin/tenants/${tenantId}`, { admin: true });
    expect(view.body.data.licenseId).toMatch(/^lic-/);
    expect(view.body.data.branches[0].pos.lastSeenAt).toEqual(expect.any(String));

    const revoked = await call('POST', `/api/admin/tenants/${tenantId}/revoke`, { admin: true });
    expect(revoked.body.data.revoked).toBe(1);
    const res = await call('GET', '/api/pos/status', { token: body.data.token });
    expect(res.body.error?.code).toBe('POS_TOKEN_REVOKED');

    expect((await call('DELETE', `/api/admin/tenants/${tenantId}`, { admin: true })).status).toBe(
      200,
    );
    expect((await call('GET', `/api/admin/tenants/${tenantId}`, { admin: true })).status).toBe(404);
    const orphan = await env.DB.prepare('SELECT COUNT(*) AS n FROM branches WHERE tenant_id = ?')
      .bind(tenantId)
      .first<{ n: number }>();
    expect(orphan?.n).toBe(0);
  });
});

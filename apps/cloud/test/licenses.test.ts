import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  activate,
  call,
  heartbeat,
  licensePayload,
  registerLicense,
  registryRow,
  signLicense,
  unique,
} from './helpers';

async function foreignKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  return btoa(String.fromCharCode(...pkcs8));
}

async function tenantIdOf(branchId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT tenant_id FROM branches WHERE id = ?')
    .bind(branchId)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? '';
}

describe('satici lisans kaydi', () => {
  it('anahtarsiz 401', async () => {
    expect((await call('GET', '/api/admin/licenses')).status).toBe(401);
    const put = await call('PUT', '/api/admin/licenses', {
      json: { licenseKey: await signLicense(licensePayload()) },
    });
    expect([put.status, put.body.error?.code]).toEqual([401, 'ADMIN_TOKEN_INVALID']);
    expect((await call('POST', '/api/admin/licenses/lic-yok-00000/revoke')).status).toBe(401);
  });

  it('kayit imzayi dogrular ve lisans numarasi ister', async () => {
    const cases: Array<[string, number, string]> = [
      [await signLicense(licensePayload(), await foreignKey()), 400, 'LICENSE_INVALID'],
      ['ADO1.bozuk.anahtar-ama-yeterince-uzun', 400, 'LICENSE_INVALID'],
      [await signLicense(licensePayload({ id: undefined })), 400, 'LICENSE_ID_REQUIRED'],
    ];
    for (const [licenseKey, status, code] of cases) {
      const res = await registerLicense(licenseKey);
      expect([res.status, res.body.error?.code]).toEqual([status, code]);
    }
    expect((await call('PUT', '/api/admin/licenses', { admin: true, json: {} })).status).toBe(422);
  });

  it('yeni lisansi kaydeder (kaynak admin), notu tutar; isletme yoksa da kayit acilir', async () => {
    const payload = licensePayload({ c: 'Kayıt Lokantası', p: 'yearly', f: { 'qr.menu': true } });
    const key = await signLicense(payload);
    const created = await registerLicense(key, 'Fatura 2026/41');
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      id: payload.id,
      customer: 'Kayıt Lokantası',
      plan: 'yearly',
      exp: '2099-01-01',
      graceDays: 14,
      expiresAt: '2099-01-15T00:00:00.000Z',
      expired: false,
      features: { 'qr.menu': true },
      source: 'admin',
      revoked: false,
      notes: 'Fatura 2026/41',
      tenant: null,
      lastSeenAt: null,
      health: null,
      licenseKey: key,
      applied: true,
    });

    // Ayni anahtar yeniden: 200, not verilmezse korunur.
    const again = await registerLicense(key);
    expect([again.status, again.body.data.applied, again.body.data.notes]).toEqual([
      200,
      true,
      'Fatura 2026/41',
    ]);

    // POS sonra bu lisansla baglanir: isletme kayda baglanir, kaynak degismez (anahtar ayni).
    const linked = await activate({ licenseKey: key });
    expect(linked.status).toBe(201);
    expect(await registryRow(payload.id)).toMatchObject({
      tenant_id: await tenantIdOf(linked.body.data.branch.id),
      source: 'admin',
    });
  });

  it('kayit geri gitmez: daha eski anahtar uygulanmaz', async () => {
    const payload = licensePayload({ exp: '2099-06-01' });
    const newer = await signLicense(payload);
    expect((await registerLicense(newer)).status).toBe(201);

    const older = await registerLicense(await signLicense({ ...payload, exp: '2098-01-01' }));
    expect(older.status).toBe(200);
    expect(older.body.data).toMatchObject({
      applied: false,
      exp: '2099-06-01',
      expiresAt: '2099-06-15T00:00:00.000Z',
      licenseKey: newer,
    });
    expect(
      (await call('GET', `/api/admin/licenses/${payload.id}`, { admin: true })).body.data,
    ).toMatchObject({ exp: '2099-06-01', licenseKey: newer });
  });

  it('kayit bagli isletmeyi gunceller; POS yeni anahtari heartbeat yanitinda alir', async () => {
    const payload = licensePayload({ exp: '2098-01-01', f: { 'qr.menu': true } });
    const shop = await activate({ licenseKey: await signLicense(payload) });
    const tenantId = await tenantIdOf(shop.body.data.branch.id);

    const renewed = await signLicense({
      ...payload,
      exp: '2099-02-01',
      c: 'Yenilenen Lokanta',
      f: { 'qr.menu': true, 'qr.order': true },
    });
    const res = await registerLicense(renewed);
    expect(res.body.data).toMatchObject({
      applied: true,
      tenant: { id: tenantId, name: 'Yenilenen Lokanta', status: 'active' },
    });
    const tenant = await call('GET', `/api/admin/tenants/${tenantId}`, { admin: true });
    expect(tenant.body.data).toMatchObject({
      name: 'Yenilenen Lokanta',
      plan: 'order',
      licenseExpiresAt: '2099-02-15T00:00:00.000Z',
      registry: { revoked: false, source: 'admin', exp: '2099-02-01' },
    });
    expect(tenant.body.data.features).toMatchObject({ 'qr.menu': true, 'qr.order': true });

    const beat = await heartbeat(shop.body.data.token, {
      licenseId: payload.id,
      licenseExp: '2098-01-01',
    });
    expect(beat.body.data.remote).toEqual({ state: 'active', update: renewed });
  });

  it('liste: isletme adi, son gorulme, surum, saglik, iptal; anahtar listede yok', async () => {
    const payload = licensePayload({ c: 'Liste Lokantası' });
    const shop = await activate({
      licenseKey: await signLicense(payload),
      headers: { 'X-Ado-Version': '0.4.0' },
    });
    await heartbeat(shop.body.data.token, { licenseId: payload.id, licenseExp: payload.exp });

    const list = await call('GET', '/api/admin/licenses', { admin: true });
    expect(list.status).toBe(200);
    const row = list.body.data.find((item: { id: string }) => item.id === payload.id);
    expect(row).toMatchObject({
      customer: 'Liste Lokantası',
      source: 'activation',
      revoked: false,
      tenant: { name: 'Liste Lokantası', status: 'active' },
      lastSeenAt: expect.any(String),
      appVersion: '0.4.0',
      installId: expect.any(String),
      health: { dbBytes: 12_345_678, licenseExp: payload.exp },
    });
    expect(row).not.toHaveProperty('licenseKey');
    expect((await call('GET', '/api/admin/licenses/lic-yok-00000', { admin: true })).status).toBe(
      404,
    );
  });
});

describe('lisans iptali', () => {
  it('iptal: baglanma ve yenileme 403 LICENSE_REVOKED, isletme silinse de; kaldirinca baglanir', async () => {
    const payload = licensePayload();
    const licenseKey = await signLicense(payload);
    const installId = unique('inst');
    const shop = await activate({ licenseKey, installId });
    const token = shop.body.data.token;
    const tenantId = await tenantIdOf(shop.body.data.branch.id);

    const revoked = await call('POST', `/api/admin/licenses/${payload.id}/revoke`, {
      admin: true,
      json: { reason: 'Çalıntı lisans' },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toMatchObject({
      revoked: true,
      revokedAt: expect.any(String),
      revokeReason: 'Çalıntı lisans',
    });
    // Ikinci iptal ilk zamani korur; govdesiz istek de kabul edilir.
    const twice = await call('POST', `/api/admin/licenses/${payload.id}/revoke`, { admin: true });
    expect(twice.body.data).toMatchObject({
      revokedAt: revoked.body.data.revokedAt,
      revokeReason: 'Çalıntı lisans',
    });

    const relink = await activate({ licenseKey, installId });
    expect([relink.status, relink.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
    const renew = await call('PUT', '/api/pos/license', { token, json: { licenseKey } });
    expect([renew.status, renew.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
    const newer = await signLicense({ ...payload, exp: '2099-12-01' });
    const renewNewer = await call('PUT', '/api/pos/license', {
      token,
      json: { licenseKey: newer },
    });
    expect(renewNewer.body.error?.code).toBe('LICENSE_REVOKED');

    // Isletme silinir: kayit (ve iptal) kalir, yeniden baglanma yine reddedilir.
    expect((await call('DELETE', `/api/admin/tenants/${tenantId}`, { admin: true })).status).toBe(
      200,
    );
    expect(await registryRow(payload.id)).toMatchObject({
      tenant_id: null,
      revoke_reason: 'Çalıntı lisans',
    });
    const afterDelete = await activate({ licenseKey, installId: unique('inst') });
    expect([afterDelete.status, afterDelete.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
    const listed = await call('GET', `/api/admin/licenses/${payload.id}`, { admin: true });
    expect(listed.body.data).toMatchObject({ revoked: true, tenant: null });

    // Iptal kaldirilir: lisans yeniden baglanir, isletme yeniden acilir.
    const unrevoked = await call('POST', `/api/admin/licenses/${payload.id}/unrevoke`, {
      admin: true,
    });
    expect(unrevoked.body.data).toMatchObject({
      revoked: false,
      revokedAt: null,
      revokeReason: null,
    });
    const back = await activate({ licenseKey, installId });
    expect(back.status).toBe(201);
    expect(await registryRow(payload.id)).toMatchObject({
      tenant_id: await tenantIdOf(back.body.data.branch.id),
      revoked_at: null,
    });
  });

  it('kayitli olmayan lisans iptal edilemez (404); once kaydedilir', async () => {
    const payload = licensePayload();
    const missing = await call('POST', `/api/admin/licenses/${payload.id}/revoke`, {
      admin: true,
    });
    expect([missing.status, missing.body.error?.code]).toEqual([404, 'LICENSE_NOT_FOUND']);
    const unrevoke = await call('POST', `/api/admin/licenses/${payload.id}/unrevoke`, {
      admin: true,
    });
    expect(unrevoke.status).toBe(404);

    await registerLicense(await signLicense(payload));
    const revoked = await call('POST', `/api/admin/licenses/${payload.id}/revoke`, {
      admin: true,
    });
    expect(revoked.body.data.revoked).toBe(true);
    // Kaydedilmis ama hic baglanmamis iptal lisans da baglanamaz.
    const res = await activate({ licenseKey: await signLicense(payload) });
    expect([res.status, res.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
  });

  it('iptal edilmis lisansa yeni anahtar kaydedilebilir ama iptal kalir', async () => {
    const payload = licensePayload({ exp: '2098-01-01' });
    await registerLicense(await signLicense(payload));
    await call('POST', `/api/admin/licenses/${payload.id}/revoke`, { admin: true });
    const res = await registerLicense(await signLicense({ ...payload, exp: '2099-01-01' }));
    expect(res.body.data).toMatchObject({ applied: true, exp: '2099-01-01', revoked: true });
  });
});

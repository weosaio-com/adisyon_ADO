import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { heartbeatResponseSchema } from '@ado/shared/cloud-api';
import {
  activate,
  activatedBranch,
  call,
  heartbeat,
  licensePayload,
  registerLicense,
  sampleMenu,
  signLicense,
  tableCode,
  unique,
} from './helpers';

describe('POS heartbeat', () => {
  it('belirtecsiz ya da gecersiz belirtecle 401, bozuk govdeyle 422', async () => {
    const anonymous = await heartbeat(undefined);
    expect([anonymous.status, anonymous.body.error?.code]).toEqual([401, 'POS_TOKEN_INVALID']);
    const wrong = await heartbeat('adoqr_pos_yanlis');
    expect([wrong.status, wrong.body.error?.code]).toEqual([401, 'POS_TOKEN_INVALID']);

    const { token } = await activatedBranch();
    const negative = await heartbeat(token, { dbBytes: -1 });
    expect([negative.status, negative.body.error?.code]).toEqual([422, 'VALIDATION_ERROR']);
    // Alan atlanamaz: bilinmeyen deger null gonderilir.
    const missing = await call('POST', '/api/pos/heartbeat', {
      token,
      json: { appVersion: '0.4.0' },
    });
    expect(missing.status).toBe(422);
  });

  it('saglik, surum ve son gorulme yazilir; yanit sozlesmeye uyar', async () => {
    const shop = await activatedBranch({ c: 'Sağlık Lokantası' });
    await env.DB.prepare('UPDATE branches SET pos_last_seen_at = ? WHERE id = ?')
      .bind('2026-01-01T00:00:00.000Z', shop.branchId)
      .run();
    const res = await heartbeat(shop.token, {
      appVersion: '0.4.1',
      licenseId: shop.licenseId,
      licenseExp: '2099-01-01',
    });
    expect(res.status).toBe(200);
    const parsed = heartbeatResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
    expect(res.body.data).toMatchObject({
      branch: { id: shop.branchId },
      tenant: { name: 'Sağlık Lokantası', status: 'active' },
      license: { id: shop.licenseId, expiresAt: '2099-01-15T00:00:00.000Z' },
      remote: { state: 'active' },
      menu: null,
    });
    expect(res.body.data.remote).not.toHaveProperty('update');
    expect(Math.abs(Date.parse(res.body.data.serverTime) - Date.now())).toBeLessThan(60_000);

    const row = await env.DB.prepare('SELECT * FROM branches WHERE id = ?')
      .bind(shop.branchId)
      .first<Record<string, string | number | null>>();
    expect(row).toMatchObject({
      pos_app_version: '0.4.1',
      health_db_bytes: 12_345_678,
      health_backups_bytes: 45_000_000,
      health_free_disk_bytes: 50_000_000_000,
      health_last_backup_at: '2026-10-14T06:00:01.000Z',
      health_last_cloud_backup_at: null,
      health_license_exp: '2099-01-01',
    });
    expect(row?.health_reported_at).toEqual(expect.any(String));
    expect(row?.pos_last_seen_at).toBe(row?.health_reported_at);

    // Satici ayrintisinda subenin sagligi gorunur.
    const detail = await call('GET', `/api/admin/tenants/${shop.tenantId}`, { admin: true });
    expect(detail.body.data.branches[0].health).toMatchObject({
      dbBytes: 12_345_678,
      freeDiskBytes: 50_000_000_000,
      lastBackupAt: '2026-10-14T06:00:01.000Z',
      lastCloudBackupAt: null,
      licenseExp: '2099-01-01',
    });
    expect(detail.body.data.branches[0].pos.appVersion).toBe('0.4.1');

    // Gecersiz surum metni yazilmaz (oncekisi kalir); bilinmeyen surum null olabilir. Saglik
    // alanlarinda son bildirim gecerlidir (null = bilinmiyor).
    await heartbeat(shop.token, { appVersion: 'kotu surum <script>' });
    await heartbeat(shop.token, { appVersion: null, dbBytes: null });
    const after = await env.DB.prepare(
      'SELECT pos_app_version, health_db_bytes, health_license_exp FROM branches WHERE id = ?',
    )
      .bind(shop.branchId)
      .first<Record<string, string | number | null>>();
    expect(after).toEqual({
      pos_app_version: '0.4.1',
      health_db_bytes: null,
      health_license_exp: null,
    });
  });

  it('menu surumu yanitta doner', async () => {
    const { token } = await activatedBranch();
    await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    const res = await heartbeat(token);
    expect(res.body.data.menu).toMatchObject({ version: 1, updatedAt: expect.any(String) });
  });

  it('uzak durum: iptal > askida > suresi dolmus > etkin', async () => {
    const shop = await activatedBranch();
    const state = async () => (await heartbeat(shop.token)).body.data.remote.state;
    const patch = (json: unknown) =>
      call('PATCH', `/api/admin/tenants/${shop.tenantId}`, { admin: true, json });
    const expire = (iso: string) =>
      env.DB.prepare('UPDATE tenants SET license_expires_at = ? WHERE id = ?')
        .bind(iso, shop.tenantId)
        .run();

    expect(await state()).toBe('active');
    await expire(new Date(Date.now() - 1000).toISOString());
    expect(await state()).toBe('expired');
    await patch({ status: 'suspended' });
    expect(await state()).toBe('suspended');
    await call('POST', `/api/admin/licenses/${shop.licenseId}/revoke`, { admin: true });
    expect(await state()).toBe('revoked');

    await call('POST', `/api/admin/licenses/${shop.licenseId}/unrevoke`, { admin: true });
    expect(await state()).toBe('suspended');
    await patch({ status: 'active' });
    expect(await state()).toBe('expired');
    await expire('2099-01-15T00:00:00.000Z');
    expect(await state()).toBe('active');
  });

  it('yenileme: kayitta ayni kimlikli, daha gec bitisli anahtar varsa POS alir', async () => {
    const payload = licensePayload({ exp: '2098-01-01' });
    const installId = unique('inst');
    const first = await activate({ licenseKey: await signLicense(payload), installId });
    const token = first.body.data.token;
    const pos = { licenseId: payload.id, licenseExp: '2098-01-01' };

    // Kayitta POS'unkiyle ayni anahtar: yenileme yok.
    expect((await heartbeat(token, pos)).body.data.remote).toEqual({ state: 'active' });

    // Satici yeni lisansi kaydeder; POS eski bitisi bildirdikce anahtari alir.
    const renewed = await signLicense({ ...payload, exp: '2099-03-01' });
    expect((await registerLicense(renewed)).status).toBe(200);
    const res = await heartbeat(token, pos);
    expect(res.body.data.remote).toEqual({ state: 'active', update: renewed });
    expect(res.body.data.license.expiresAt).toBe('2099-03-15T00:00:00.000Z');
    expect(heartbeatResponseSchema.safeParse(res.body.data).success).toBe(true);

    // POS kurup yeni bitisi bildirince dongu yok; farkli kimlik ya da bilinmeyen lisans da almaz.
    const cases = [
      { licenseId: payload.id, licenseExp: '2099-03-01' },
      { licenseId: payload.id, licenseExp: '2099-12-31' },
      { licenseId: 'lic_baska_lisans_01', licenseExp: '2098-01-01' },
      { licenseId: null, licenseExp: null },
      { licenseId: payload.id, licenseExp: null },
    ];
    for (const body of cases) {
      expect((await heartbeat(token, body)).body.data.remote).toEqual({ state: 'active' });
    }

    // Iptal edilen lisans yenilenmez.
    await call('POST', `/api/admin/licenses/${payload.id}/revoke`, { admin: true });
    expect((await heartbeat(token, pos)).body.data.remote).toEqual({ state: 'revoked' });
  });

  it('iptalde belirtec kalir: heartbeat calisir, yayin 403 LICENSE_REVOKED, menu yayindan kalkar', async () => {
    const shop = await activatedBranch();
    const code = tableCode();
    await call('PUT', '/api/pos/menu', { token: shop.token, json: sampleMenu() });
    await call('PUT', '/api/pos/tables', {
      token: shop.token,
      json: { tables: [{ code, name: 'Masa 1' }] },
    });
    expect((await call('GET', `/api/m/${code}`)).status).toBe(200);

    const revoked = await call('POST', `/api/admin/licenses/${shop.licenseId}/revoke`, {
      admin: true,
      json: { reason: 'Ödeme yapılmadı' },
    });
    expect(revoked.body.data).toMatchObject({ revoked: true, revokeReason: 'Ödeme yapılmadı' });
    expect((await call('GET', `/api/m/${code}`)).body.error?.code).toBe('TABLE_NOT_FOUND');

    const beat = await heartbeat(shop.token);
    expect([beat.status, beat.body.data.remote.state]).toEqual([200, 'revoked']);
    for (const [method, path, json] of [
      ['PUT', '/api/pos/menu', sampleMenu()],
      ['PUT', '/api/pos/tables', { tables: [{ code, name: 'Masa 1' }] }],
      ['POST', '/api/pos/images/check', { keys: [] }],
    ] as const) {
      const res = await call(method, path, { token: shop.token, json });
      expect([res.status, res.body.error?.code]).toEqual([403, 'LICENSE_REVOKED']);
    }
    // Kapatma (unpublish) her zaman calisir.
    expect((await call('POST', '/api/pos/menu/unpublish', { token: shop.token })).status).toBe(200);
  });
});

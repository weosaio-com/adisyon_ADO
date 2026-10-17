import { describe, expect, it } from 'vitest';
import { activatedBranch, call } from './helpers';

describe('satici API', () => {
  it('anahtarsiz ya da yanlis anahtarla 401', async () => {
    expect((await call('GET', '/api/admin/tenants')).status).toBe(401);
    const wrong = await call('GET', '/api/admin/tenants', { token: 'yanlis-anahtar-0123456789' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe('ADMIN_TOKEN_INVALID');
  });

  it('lisansla acilan isletmeyi listeler; ayrintida sube ve POS bilgisi', async () => {
    const shop = await activatedBranch({
      c: 'Satıcı Testi',
      f: { 'qr.menu': true, 'qr.order': true },
    });
    const list = await call('GET', '/api/admin/tenants', { admin: true });
    const row = list.body.data.find((t: { id: string }) => t.id === shop.tenantId);
    expect(row).toMatchObject({ name: 'Satıcı Testi', plan: 'order', licenseId: shop.licenseId });

    const detail = await call('GET', `/api/admin/tenants/${shop.tenantId}`, { admin: true });
    expect(detail.body.data.features).toMatchObject({
      'qr.menu': true,
      'qr.order': true,
      'qr.pay': false,
    });
    expect(detail.body.data).not.toHaveProperty('users');
    expect(detail.body.data.branches).toHaveLength(1);
    // Heartbeat gelmeden saglik bilgisi yok.
    expect(detail.body.data.branches[0]).toMatchObject({
      id: shop.branchId,
      menu: null,
      health: null,
    });
    expect(detail.body.data.branches[0].pos.pairedAt).toBeTruthy();
    expect(detail.body.data.branches[0].pos.installId).toEqual(expect.any(String));
    expect(detail.body.data.branches[0]).not.toHaveProperty('source');
    expect(detail.body.data.registry).toMatchObject({ revoked: false, source: 'activation' });
  });

  it('isletme acma, eslestirme kodu ve parola uclari kaldirildi', async () => {
    const created = await call('POST', '/api/admin/tenants', {
      admin: true,
      json: { name: 'Elle', plan: 'menu' },
    });
    expect(created.status).toBe(404);
    const shop = await activatedBranch();
    const code = await call('POST', `/api/admin/branches/${shop.branchId}/pairing-code`, {
      admin: true,
    });
    expect(code.status).toBe(404);
    const password = await call('POST', '/api/admin/users/yok/password', {
      admin: true,
      json: { password: 'sifirlanan-parola-1' },
    });
    expect(password.status).toBe(404);
  });

  it('durum ve tek tek ozellik degistirir', async () => {
    const shop = await activatedBranch();
    const path = `/api/admin/tenants/${shop.tenantId}`;
    const up = await call('PATCH', path, { admin: true, json: { features: { 'qr.games': true } } });
    expect(up.body.data.features).toMatchObject({ 'qr.menu': true, 'qr.games': true });
    const suspended = await call('PATCH', path, { admin: true, json: { status: 'suspended' } });
    expect(Object.values(suspended.body.data.features).every((on) => on === false)).toBe(true);
    const reset = await call('PATCH', path, {
      admin: true,
      json: { status: 'active', features: { 'qr.games': null } },
    });
    expect(reset.body.data.features).toMatchObject({ 'qr.menu': true, 'qr.games': false });
    const plans = await call('GET', '/api/admin/plans', { admin: true });
    expect(Object.keys(plans.body.data.plans)).toEqual(['menu', 'order', 'pay', 'full']);
  });
});

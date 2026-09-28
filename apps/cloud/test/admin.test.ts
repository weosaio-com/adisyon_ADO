import { describe, expect, it } from 'vitest';
import { call, createTenant, login, unique } from './helpers';

describe('satici API', () => {
  it('anahtarsiz ya da yanlis anahtarla 401', async () => {
    expect((await call('GET', '/api/admin/tenants')).status).toBe(401);
    const wrong = await call('GET', '/api/admin/tenants', { token: 'yanlis-anahtar-0123456789' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe('ADMIN_TOKEN_INVALID');
  });

  it('isletme acar; e-posta tekrar kullanilamaz; zayif parola reddedilir', async () => {
    const tenant = await createTenant({ plan: 'order' });
    const list = await call('GET', '/api/admin/tenants', { admin: true });
    expect(list.body.data.some((t: { id: string }) => t.id === tenant.tenantId)).toBe(true);

    const detail = await call('GET', `/api/admin/tenants/${tenant.tenantId}`, { admin: true });
    expect(detail.body.data.plan).toBe('order');
    expect(detail.body.data.features).toMatchObject({
      'qr.menu': true,
      'qr.order': true,
      'qr.pay': false,
    });
    expect(detail.body.data.users[0].email).toBe(tenant.email);
    expect(detail.body.data.branches[0]).toMatchObject({ id: tenant.branchId, source: 'panel' });

    const dup = await call('POST', '/api/admin/tenants', {
      admin: true,
      json: {
        name: 'Başka',
        plan: 'menu',
        owner: { email: tenant.email, password: 'uzun-parola-123' },
      },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('EMAIL_TAKEN');

    const weak = await call('POST', '/api/admin/tenants', {
      admin: true,
      json: {
        name: 'Zayıf',
        plan: 'menu',
        owner: { email: `${unique('w')}@example.com`, password: '123' },
      },
    });
    expect(weak.status).toBe(422);
    const badPlan = await call('POST', '/api/admin/tenants', {
      admin: true,
      json: {
        name: 'Paket',
        plan: 'altin',
        owner: { email: `${unique('p')}@example.com`, password: 'uzun-parola-123' },
      },
    });
    expect(badPlan.status).toBe(422);
  });

  it('paket, durum ve tek tek ozellik degistirir', async () => {
    const tenant = await createTenant();
    const up = await call('PATCH', `/api/admin/tenants/${tenant.tenantId}`, {
      admin: true,
      json: { plan: 'pay', features: { 'qr.games': true } },
    });
    expect(up.body.data.features).toMatchObject({
      'qr.menu': true,
      'qr.pay': true,
      'qr.split': true,
      'qr.games': true,
    });
    const suspended = await call('PATCH', `/api/admin/tenants/${tenant.tenantId}`, {
      admin: true,
      json: { status: 'suspended' },
    });
    expect(Object.values(suspended.body.data.features).every((on) => on === false)).toBe(true);
    const reset = await call('PATCH', `/api/admin/tenants/${tenant.tenantId}`, {
      admin: true,
      json: { status: 'active', features: { 'qr.games': null } },
    });
    expect(reset.body.data.features['qr.games']).toBe(false);
    const plans = await call('GET', '/api/admin/plans', { admin: true });
    expect(Object.keys(plans.body.data.plans)).toEqual(['menu', 'order', 'pay', 'full']);
  });

  it('satici subeye POS eslestirme kodu uretebilir', async () => {
    const tenant = await createTenant();
    const code = await call('POST', `/api/admin/branches/${tenant.branchId}/pairing-code`, {
      admin: true,
    });
    expect(code.status).toBe(201);
    const paired = await call('POST', '/api/pos/pair', {
      json: { code: code.body.data.code },
      ip: unique('ip'),
    });
    expect(paired.status).toBe(201);
  });

  it('parola sifirlama tum oturumlari kapatir', async () => {
    const tenant = await createTenant();
    const cookie = await login(tenant.email, tenant.password);
    const reset = await call('POST', `/api/admin/users/${tenant.userId}/password`, {
      admin: true,
      json: { password: 'sifirlanan-parola-1' },
    });
    expect(reset.status).toBe(200);
    expect((await call('GET', '/api/panel/me', { cookie })).status).toBe(401);
    await expect(login(tenant.email, 'sifirlanan-parola-1')).resolves.toMatch(/ado_session/);
    const missing = await call('POST', '/api/admin/users/yok/password', {
      admin: true,
      json: { password: 'sifirlanan-parola-1' },
    });
    expect(missing.status).toBe(404);
  });
});

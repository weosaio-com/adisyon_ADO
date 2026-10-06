import { describe, expect, it } from 'vitest';
import { call, createTenant, login, png, request, sampleMenu, unique } from './helpers';

describe('panel girisi', () => {
  it('yanlis parola 401; dogru parola guvenli oturum cerezi verir', async () => {
    const tenant = await createTenant();
    const wrong = await call('POST', '/api/panel/login', {
      json: { email: tenant.email, password: 'yanlis-parola-1' },
      ip: unique('ip'),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe('LOGIN_FAILED');
    const unknown = await call('POST', '/api/panel/login', {
      json: { email: 'yok@example.com', password: 'yanlis-parola-1' },
      ip: unique('ip'),
    });
    expect(unknown.body.error?.code).toBe('LOGIN_FAILED');

    const res = await request('POST', '/api/panel/login', {
      json: { email: tenant.email.toUpperCase(), password: tenant.password },
      ip: unique('ip'),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/^__Host-ado_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('ayni IP ya da e-postadan 10 denemeden sonra 429', async () => {
    const tenant = await createTenant();
    const ip = unique('ip');
    for (let i = 0; i < 10; i++) {
      await call('POST', '/api/panel/login', {
        json: { email: tenant.email, password: 'yanlis-parola-1' },
        ip,
      });
    }
    const limited = await call('POST', '/api/panel/login', {
      json: { email: tenant.email, password: tenant.password },
      ip,
    });
    expect(limited.status).toBe(429);
    // Baska IP'den de ayni e-postaya sinir uygulanir.
    const otherIp = await call('POST', '/api/panel/login', {
      json: { email: tenant.email, password: tenant.password },
      ip: unique('ip'),
    });
    expect(otherIp.status).toBe(429);
  });

  it('baska kokenden form gonderimi (CSRF) reddedilir', async () => {
    const res = await request('POST', '/api/panel/login', {
      body: 'email=a@b.co&password=x',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://kotu.example',
      },
    });
    expect(res.status).toBe(403);
  });

  it('oturumsuz istek 401; me isletme, paket ve subeleri doner; cikis oturumu kapatir', async () => {
    expect((await call('GET', '/api/panel/me')).status).toBe(401);
    const tenant = await createTenant({ plan: 'full' });
    const cookie = await login(tenant.email, tenant.password);
    const me = await call('GET', '/api/panel/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(tenant.email);
    expect(me.body.data.tenant.planLabel).toBe('Tümü');
    expect(me.body.data.tenant.features['qr.games']).toBe(true);
    expect(me.body.data.branches).toHaveLength(1);
    expect(me.body.data.branches[0]).toMatchObject({ id: tenant.branchId, source: 'panel' });

    await call('POST', '/api/panel/logout', { cookie });
    expect((await call('GET', '/api/panel/me', { cookie })).status).toBe(401);
  });

  it('parola degisince eski parola ve diger oturumlar gecersizlesir', async () => {
    const tenant = await createTenant();
    const first = await login(tenant.email, tenant.password);
    const second = await login(tenant.email, tenant.password);
    const wrong = await call('POST', '/api/panel/password', {
      cookie: first,
      json: { currentPassword: 'yanlis-parola-1', newPassword: 'yeni-parola-12345' },
    });
    expect(wrong.status).toBe(403);
    const short = await call('POST', '/api/panel/password', {
      cookie: first,
      json: { currentPassword: tenant.password, newPassword: 'kisa' },
    });
    expect(short.status).toBe(422);
    const changed = await call('POST', '/api/panel/password', {
      cookie: first,
      json: { currentPassword: tenant.password, newPassword: 'yeni-parola-12345' },
    });
    expect(changed.status).toBe(200);
    expect((await call('GET', '/api/panel/me', { cookie: first })).status).toBe(200);
    expect((await call('GET', '/api/panel/me', { cookie: second })).status).toBe(401);
    await expect(login(tenant.email, tenant.password)).rejects.toThrow();
    await expect(login(tenant.email, 'yeni-parola-12345')).resolves.toMatch(/ado_session/);
  });
});

describe('panelde menu', () => {
  it('ilk kayit, surum cakismasi ve dogrulama', async () => {
    const tenant = await createTenant();
    const cookie = await login(tenant.email, tenant.password);
    const path = `/api/panel/branches/${tenant.branchId}/menu`;
    const empty = await call('GET', path, { cookie });
    expect(empty.body.data).toMatchObject({ source: 'panel', version: null, menu: null });

    const v1 = await call('PUT', path, { cookie, json: { baseVersion: null, menu: sampleMenu() } });
    expect(v1.body.data.version).toBe(1);
    // Baska sekme hala "menu yok" saniyor.
    const stale = await call('PUT', path, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu() },
    });
    expect(stale.body.error?.code).toBe('VERSION_CONFLICT');
    const v2 = await call('PUT', path, { cookie, json: { baseVersion: 1, menu: sampleMenu() } });
    expect(v2.body.data.version).toBe(2);
    const staleAgain = await call('PUT', path, {
      cookie,
      json: { baseVersion: 1, menu: sampleMenu() },
    });
    expect(staleAgain.status).toBe(409);

    const bad = sampleMenu();
    bad.products[0]!.price = -5;
    const invalid = await call('PUT', path, { cookie, json: { baseVersion: 2, menu: bad } });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.details).toEqual([
      expect.objectContaining({ field: 'menu.products.0.price' }),
    ]);

    const saved = await call('GET', path, { cookie });
    expect(saved.body.data.version).toBe(2);
    expect(saved.body.data.menu.categories[0].translations.en.name).toBe('Soups');
  });

  it('gorsel yuklenmeden menude kullanilamaz; yuklenince kullanilir', async () => {
    const tenant = await createTenant();
    const cookie = await login(tenant.email, tenant.password);
    const menuPath = `/api/panel/branches/${tenant.branchId}/menu`;
    const orphan = await call('PUT', menuPath, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu(`${'a'.repeat(64)}.webp`) },
    });
    expect(orphan.body.error?.code).toBe('IMAGES_MISSING');

    const text = await call('POST', `/api/panel/branches/${tenant.branchId}/images`, {
      cookie,
      body: 'merhaba',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(text.status).toBe(400);
    const upload = await call<{ key: string }>(
      'POST',
      `/api/panel/branches/${tenant.branchId}/images`,
      { cookie, body: png(), headers: { 'Content-Type': 'application/octet-stream' } },
    );
    const saved = await call('PUT', menuPath, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu(upload.body.data.key) },
    });
    expect(saved.status).toBe(200);
  });

  it('baska isletmenin subesine erisilemez', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const cookie = await login(a.email, a.password);
    const res = await call('GET', `/api/panel/branches/${b.branchId}/menu`, { cookie });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('BRANCH_NOT_FOUND');
  });
});

describe('panelde masalar', () => {
  it('ekle, yeniden adlandir, kodu yenile, sil', async () => {
    const tenant = await createTenant();
    const cookie = await login(tenant.email, tenant.password);
    const base = `/api/panel/branches/${tenant.branchId}`;
    await call('PUT', `${base}/menu`, { cookie, json: { baseVersion: null, menu: sampleMenu() } });

    const created = await call('POST', `${base}/tables`, { cookie, json: { name: 'Masa 1' } });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toMatch(/^[A-Z2-7]{16}$/);
    await call('POST', `${base}/tables`, { cookie, json: { name: 'Masa 2', hall: 'Bahçe' } });
    const list = await call('GET', `${base}/tables`, { cookie });
    expect(list.body.data.map((t: { name: string }) => t.name)).toEqual(['Masa 1', 'Masa 2']);
    expect((await call('POST', `${base}/tables`, { cookie, json: { name: ' ' } })).status).toBe(
      422,
    );

    const id = created.body.data.id as string;
    const oldCode = created.body.data.code as string;
    const renamed = await call('PATCH', `${base}/tables/${id}`, {
      cookie,
      json: { name: 'Pencere' },
    });
    expect(renamed.body.data.name).toBe('Pencere');

    const rotated = await call('POST', `${base}/tables/${id}/rotate`, { cookie });
    expect(rotated.body.data.code).not.toBe(oldCode);
    expect((await call('GET', `/api/m/${oldCode}`)).status).toBe(404);
    expect((await call('GET', `/api/m/${rotated.body.data.code}`)).status).toBe(200);

    await call('DELETE', `${base}/tables/${id}`, { cookie });
    expect((await call('GET', `/api/m/${rotated.body.data.code}`)).status).toBe(404);
    expect((await call('DELETE', `${base}/tables/${id}`, { cookie })).status).toBe(404);
  });
});

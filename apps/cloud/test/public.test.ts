import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, createTenant, login, png, request, sampleMenu, sha256Hex } from './helpers';

// Panelde masa ekleyip menu kaydeden POS'suz isletme.
async function publishedTable(plan = 'menu') {
  const tenant = await createTenant({ plan });
  const cookie = await login(tenant.email, tenant.password);
  const table = await call<{ code: string; id: string }>(
    'POST',
    `/api/panel/branches/${tenant.branchId}/tables`,
    { cookie, json: { name: 'Masa 5', hall: 'Bahçe' } },
  );
  return { tenant, cookie, code: table.body.data.code };
}

describe('genel menu /api/m/:code', () => {
  it('saglik ucu calisir', async () => {
    const res = await call('GET', '/api/health');
    expect(res.status).toBe(200);
  });

  it('gecersiz ya da bilinmeyen kod 404', async () => {
    expect((await call('GET', '/api/m/kisa')).status).toBe(404);
    const unknown = await call('GET', '/api/m/AAAAAAAAAAAAAAAA');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.code).toBe('TABLE_NOT_FOUND');
  });

  it('menu yayinlanmadan 404, yayinlaninca masa ve menu doner', async () => {
    const { tenant, cookie, code } = await publishedTable();
    const before = await call('GET', `/api/m/${code}`);
    expect(before.body.error?.code).toBe('MENU_NOT_PUBLISHED');

    await call('PUT', `/api/panel/branches/${tenant.branchId}/menu`, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu() },
    });
    const res = await call('GET', `/api/m/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.data.table).toEqual({ name: 'Masa 5', hall: 'Bahçe' });
    expect(res.body.data.features).toEqual({ order: false, pay: false });
    expect(res.body.data.menu.products[0].name).toBe('Mercimek');
    expect(res.body.data.menu.branch.currency).toBe('TRY');
    // QR elle yazilirsa kucuk harf de kabul.
    expect((await call('GET', `/api/m/${code.toLowerCase()}`)).status).toBe(200);
  });

  it('degismeyen menu 304, degisince yeni ETag', async () => {
    const { tenant, cookie, code } = await publishedTable();
    await call('PUT', `/api/panel/branches/${tenant.branchId}/menu`, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu() },
    });
    const first = await request('GET', `/api/m/${code}`);
    const etag = first.headers.get('ETag') ?? '';
    expect(first.headers.get('Cache-Control')).toBe('no-cache');
    const again = await request('GET', `/api/m/${code}`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);

    const menu = sampleMenu();
    menu.products[0]!.available = false;
    await call('PUT', `/api/panel/branches/${tenant.branchId}/menu`, {
      cookie,
      json: { baseVersion: 1, menu },
    });
    const changed = await request('GET', `/api/m/${code}`, { headers: { 'If-None-Match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('ETag')).not.toBe(etag);
  });

  it('paketinde QR menu olmayan ya da askiya alinan isletmede 403', async () => {
    const { tenant, cookie, code } = await publishedTable();
    await call('PUT', `/api/panel/branches/${tenant.branchId}/menu`, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu() },
    });
    await call('PATCH', `/api/admin/tenants/${tenant.tenantId}`, {
      admin: true,
      json: { features: { 'qr.menu': false } },
    });
    const off = await call('GET', `/api/m/${code}`);
    expect(off.status).toBe(403);
    expect(off.body.error?.code).toBe('MENU_DISABLED');

    await call('PATCH', `/api/admin/tenants/${tenant.tenantId}`, {
      admin: true,
      json: { features: { 'qr.menu': null }, status: 'suspended' },
    });
    expect((await call('GET', `/api/m/${code}`)).status).toBe(403);
    await call('PATCH', `/api/admin/tenants/${tenant.tenantId}`, {
      admin: true,
      json: { status: 'active' },
    });
    expect((await call('GET', `/api/m/${code}`)).status).toBe(200);
  });
});

describe('gorseller /img/:key', () => {
  it('yuklenen gorsel suresiz onbellekle sunulur', async () => {
    const tenant = await createTenant();
    const cookie = await login(tenant.email, tenant.password);
    const bytes = png();
    const upload = await call<{ key: string }>(
      'POST',
      `/api/panel/branches/${tenant.branchId}/images`,
      { cookie, body: bytes, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    expect(upload.status).toBe(201);
    expect(upload.body.data.key).toBe(`${await sha256Hex(bytes)}.png`);

    const res = await request('GET', `/img/${upload.body.data.key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    const etag = res.headers.get('ETag') ?? '';
    const cached = await request('GET', `/img/${upload.body.data.key}`, {
      headers: { 'If-None-Match': etag },
    });
    expect(cached.status).toBe(304);
    // R2'de gercekten tek nesne.
    expect(await env.IMAGES.head(`img/${upload.body.data.key}`)).not.toBeNull();
  });

  it('olmayan ya da gecersiz anahtar 404', async () => {
    expect((await request('GET', `/img/${'0'.repeat(64)}.png`)).status).toBe(404);
    expect((await request('GET', '/img/..%2F..%2Fsecret')).status).toBe(404);
    expect((await request('GET', '/img/abc.gif')).status).toBe(404);
  });

  it('bilinmeyen API yolu JSON 404', async () => {
    const res = await call('GET', '/api/yok');
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });
});

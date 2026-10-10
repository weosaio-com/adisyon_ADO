import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  call,
  createTenant,
  login,
  pairPos,
  png,
  request,
  sampleMenu,
  sha256Hex,
  unique,
} from './helpers';

async function pairedBranch() {
  const tenant = await createTenant();
  const cookie = await login(tenant.email, tenant.password);
  const token = await pairPos(cookie, tenant.branchId);
  return { tenant, cookie, token };
}

async function uploadImage(token: string, bytes: Uint8Array, key?: string) {
  const imageKey = key ?? `${await sha256Hex(bytes)}.png`;
  return call('PUT', `/api/pos/images/${imageKey}`, {
    token,
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

describe('POS eslestirme', () => {
  it('panelden alinan kodla eslesir; kod tek kullanimlik', async () => {
    const tenant = await createTenant();
    const cookie = await login(tenant.email, tenant.password);
    const code = await call<{ code: string; expiresAt: string }>(
      'POST',
      `/api/panel/branches/${tenant.branchId}/pairing-code`,
      { cookie },
    );
    expect(code.body.data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Kullanici kucuk harf ve bosluklu yazsa da eslesir.
    const typed = ` ${code.body.data.code.toLowerCase()} `;
    const paired = await call('POST', '/api/pos/pair', { json: { code: typed }, ip: unique('ip') });
    expect(paired.status).toBe(201);
    expect(paired.body.data.token).toMatch(/^adoqr_pos_/);
    expect(paired.body.data.branch.id).toBe(tenant.branchId);
    expect(paired.body.data.tenant.features['qr.menu']).toBe(true);

    const reuse = await call('POST', '/api/pos/pair', { json: { code: typed }, ip: unique('ip') });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error?.code).toBe('PAIRING_CODE_INVALID');

    // Belirtec bulutta yalniz ozetiyle durur.
    const row = await env.DB.prepare('SELECT source, pos_token_hash FROM branches WHERE id = ?')
      .bind(tenant.branchId)
      .first<{ source: string; pos_token_hash: string }>();
    expect(row?.source).toBe('pos');
    expect(row?.pos_token_hash).toBe(
      await sha256Hex(new TextEncoder().encode(paired.body.data.token)),
    );
  });

  it('suresi dolmus ya da yanlis kod reddedilir, denemeler sinirlanir', async () => {
    const tenant = await createTenant();
    await env.DB.prepare(
      'INSERT INTO pairing_codes (code_hash, branch_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(
        await sha256Hex(new TextEncoder().encode('OLDCODE2')),
        tenant.branchId,
        new Date(Date.now() - 1000).toISOString(),
        new Date().toISOString(),
      )
      .run();
    const ip = unique('ip');
    const expired = await call('POST', '/api/pos/pair', { json: { code: 'OLDCODE2' }, ip });
    expect(expired.status).toBe(400);
    for (let i = 0; i < 9; i++) {
      await call('POST', '/api/pos/pair', { json: { code: 'YANLIS22' }, ip });
    }
    const limited = await call('POST', '/api/pos/pair', { json: { code: 'YANLIS22' }, ip });
    expect(limited.status).toBe(429);
  });

  it('belirtecsiz ya da gecersiz belirtecle 401', async () => {
    expect((await call('GET', '/api/pos/status')).status).toBe(401);
    const bad = await call('GET', '/api/pos/status', { token: 'adoqr_pos_yanlis' });
    expect(bad.status).toBe(401);
    expect(bad.body.error?.code).toBe('POS_TOKEN_INVALID');
  });
});

describe('POS yayini', () => {
  it('eksik gorselleri bildirir, dogrulanmis gorseli yukler', async () => {
    const { token } = await pairedBranch();
    const bytes = png();
    const key = `${await sha256Hex(bytes)}.png`;
    const check = await call('POST', '/api/pos/images/check', { token, json: { keys: [key] } });
    expect(check.body.data.missing).toEqual([key]);

    const wrongHash = await uploadImage(token, png(), key);
    expect(wrongHash.body.error?.code).toBe('IMAGE_KEY_MISMATCH');
    const wrongType = await uploadImage(token, bytes, key.replace('.png', '.webp'));
    expect(wrongType.status).toBe(400);
    const text = new TextEncoder().encode('merhaba');
    const notImage = await uploadImage(token, text, `${await sha256Hex(text)}.png`);
    expect(notImage.body.error?.code).toBe('IMAGE_TYPE_INVALID');
    const huge = new Uint8Array(1024 * 1024 + 1);
    huge.set(bytes.subarray(0, 8));
    expect((await uploadImage(token, huge, key)).status).toBe(413);

    expect((await uploadImage(token, bytes)).status).toBe(201);
    const after = await call('POST', '/api/pos/images/check', { token, json: { keys: [key] } });
    expect(after.body.data.missing).toEqual([]);
  });

  it('menuyu dogrular, surumler ve masalarla birlikte yayinlar', async () => {
    const { token } = await pairedBranch();
    const invalid = await call('PUT', '/api/pos/menu', {
      token,
      json: { ...sampleMenu(), schemaVersion: 1, products: [{ id: 'x', categoryId: 'yok' }] },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.code).toBe('VALIDATION_ERROR');

    const bytes = png();
    const key = `${await sha256Hex(bytes)}.png`;
    const missing = await call('PUT', '/api/pos/menu', { token, json: sampleMenu(key) });
    expect(missing.status).toBe(409);
    expect(missing.body.error?.code).toBe('IMAGES_MISSING');
    expect(missing.body.error?.details).toEqual([key]);

    await uploadImage(token, bytes);
    const v1 = await call('PUT', '/api/pos/menu', { token, json: sampleMenu(key) });
    expect(v1.status).toBe(200);
    expect(v1.body.data.version).toBe(1);
    const v2 = await call('PUT', '/api/pos/menu', { token, json: sampleMenu(key) });
    expect(v2.body.data.version).toBe(2);

    const tables = await call('PUT', '/api/pos/tables', {
      token,
      json: {
        tables: [
          { code: 'MASAKODUAAAAAAA2', name: 'Masa 1', hall: 'Salon' },
          { code: 'MASAKODUAAAAAAA3', name: 'Masa 2' },
        ],
      },
    });
    expect(tables.body.data.count).toBe(2);
    const menu = await call('GET', '/api/m/MASAKODUAAAAAAA2');
    expect(menu.status).toBe(200);
    expect(menu.body.data.menu.products[0].imageKey).toBe(key);
    expect(menu.body.data.version).toBe(2);

    const status = await call('GET', '/api/pos/status', { token });
    expect(status.body.data.menu.version).toBe(2);
    expect(status.body.data.tableCount).toBe(2);
  });

  it('masa listesi esitlenir: ad guncellenir, cikan masa silinir, baskasinin kodu alinamaz', async () => {
    const a = await pairedBranch();
    const b = await pairedBranch();
    await call('PUT', '/api/pos/menu', { token: a.token, json: sampleMenu() });
    await call('PUT', '/api/pos/tables', {
      token: a.token,
      json: {
        tables: [
          { code: 'SYNCKODUAAAAAAA2', name: 'Masa 1' },
          { code: 'SYNCKODUAAAAAAA3', name: 'Masa 2' },
        ],
      },
    });
    await call('PUT', '/api/pos/tables', {
      token: a.token,
      json: { tables: [{ code: 'SYNCKODUAAAAAAA2', name: 'Pencere Önü', hall: 'Teras' }] },
    });
    const renamed = await call('GET', '/api/m/SYNCKODUAAAAAAA2');
    expect(renamed.body.data.table).toEqual({ name: 'Pencere Önü', hall: 'Teras' });
    expect((await call('GET', '/api/m/SYNCKODUAAAAAAA3')).status).toBe(404);

    const stolen = await call('PUT', '/api/pos/tables', {
      token: b.token,
      json: { tables: [{ code: 'SYNCKODUAAAAAAA2', name: 'Masa X' }] },
    });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error?.code).toBe('TABLE_CODE_TAKEN');
    expect((await call('GET', '/api/m/SYNCKODUAAAAAAA2')).body.data.table.name).toBe('Pencere Önü');

    const duplicate = await call('PUT', '/api/pos/tables', {
      token: a.token,
      json: {
        tables: [
          { code: 'SYNCKODUAAAAAAA4', name: 'A' },
          { code: 'SYNCKODUAAAAAAA4', name: 'B' },
        ],
      },
    });
    expect(duplicate.status).toBe(422);
  });

  it('POSlu subenin menusu ve masalari panelden degistirilemez', async () => {
    const { tenant, cookie } = await pairedBranch();
    const menu = await call('PUT', `/api/panel/branches/${tenant.branchId}/menu`, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu() },
    });
    expect(menu.body.error?.code).toBe('MENU_MANAGED_BY_POS');
    const table = await call('POST', `/api/panel/branches/${tenant.branchId}/tables`, {
      cookie,
      json: { name: 'Masa 1' },
    });
    expect(table.body.error?.code).toBe('TABLES_MANAGED_BY_POS');
  });

  it('baglanti kaldirilinca belirtec gecersizlesir, menu yayindan kalkar', async () => {
    const { tenant, cookie, token } = await pairedBranch();
    await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    expect((await call('POST', '/api/pos/unpair', { token })).status).toBe(200);
    const after = await call('GET', '/api/pos/status', { token });
    expect([after.status, after.body.error?.code]).toEqual([401, 'POS_TOKEN_UNPAIRED']);

    // Menu silindi: panel sifirdan yayinlayabilir.
    const saved = await call('PUT', `/api/panel/branches/${tenant.branchId}/menu`, {
      cookie,
      json: { baseVersion: null, menu: sampleMenu() },
    });
    expect(saved.body.data.version).toBe(1);

    // Yeniden eslesme yeni belirtec verir; panelden kaldirma da eski belirteci iptal eder.
    const again = await pairPos(cookie, tenant.branchId);
    expect(again).not.toBe(token);
    await call('DELETE', `/api/panel/branches/${tenant.branchId}/pos`, { cookie });
    expect((await request('GET', '/api/pos/status', { token: again })).status).toBe(401);
  });
});

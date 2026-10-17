import { describe, expect, it } from 'vitest';
import {
  activate,
  activatedBranch,
  call,
  licensePayload,
  png,
  sampleMenu,
  sha256Hex,
  signLicense,
  tableCode,
  unique,
} from './helpers';

async function uploadImage(token: string, bytes: Uint8Array, key?: string) {
  const imageKey = key ?? `${await sha256Hex(bytes)}.png`;
  return call('PUT', `/api/pos/images/${imageKey}`, {
    token,
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

describe('POS belirteci', () => {
  it('belirtecsiz ya da gecersiz belirtecle 401', async () => {
    expect((await call('GET', '/api/pos/status')).status).toBe(401);
    const bad = await call('GET', '/api/pos/status', { token: 'adoqr_pos_yanlis' });
    expect(bad.status).toBe(401);
    expect(bad.body.error?.code).toBe('POS_TOKEN_INVALID');
  });

  it('eslestirme kodu ve isletme paneli yollari kaldirildi', async () => {
    const pair = await call('POST', '/api/pos/pair', { json: { code: 'ABCD-EFGH' } });
    expect([pair.status, pair.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    const login = await call('POST', '/api/panel/login', {
      json: { email: 'sahip@example.com', password: 'bir-parola-123' },
    });
    expect(login.status).toBe(404);
  });
});

describe('POS yayini', () => {
  it('eksik gorselleri bildirir, dogrulanmis gorseli yukler', async () => {
    const { token } = await activatedBranch();
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
    const { token } = await activatedBranch();
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

    const [first, second] = [tableCode(), tableCode()];
    const tables = await call('PUT', '/api/pos/tables', {
      token,
      json: {
        tables: [
          { code: first, name: 'Masa 1', hall: 'Salon' },
          { code: second, name: 'Masa 2' },
        ],
      },
    });
    expect(tables.body.data.count).toBe(2);
    const menu = await call('GET', `/api/m/${first}`);
    expect(menu.status).toBe(200);
    expect(menu.body.data.menu.products[0].imageKey).toBe(key);
    expect(menu.body.data.version).toBe(2);

    const status = await call('GET', '/api/pos/status', { token });
    expect(status.body.data.menu.version).toBe(2);
    expect(status.body.data.tableCount).toBe(2);
  });

  it('masa listesi esitlenir: ad guncellenir, cikan masa silinir, baskasinin kodu alinamaz', async () => {
    const a = await activatedBranch();
    const b = await activatedBranch();
    const [kept, dropped, extra] = [tableCode(), tableCode(), tableCode()];
    await call('PUT', '/api/pos/menu', { token: a.token, json: sampleMenu() });
    await call('PUT', '/api/pos/tables', {
      token: a.token,
      json: {
        tables: [
          { code: kept, name: 'Masa 1' },
          { code: dropped, name: 'Masa 2' },
        ],
      },
    });
    await call('PUT', '/api/pos/tables', {
      token: a.token,
      json: { tables: [{ code: kept, name: 'Pencere Önü', hall: 'Teras' }] },
    });
    const renamed = await call('GET', `/api/m/${kept}`);
    expect(renamed.body.data.table).toEqual({ name: 'Pencere Önü', hall: 'Teras' });
    expect((await call('GET', `/api/m/${dropped}`)).status).toBe(404);

    const stolen = await call('PUT', '/api/pos/tables', {
      token: b.token,
      json: { tables: [{ code: kept, name: 'Masa X' }] },
    });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error?.code).toBe('TABLE_CODE_TAKEN');
    expect((await call('GET', `/api/m/${kept}`)).body.data.table.name).toBe('Pencere Önü');

    const duplicate = await call('PUT', '/api/pos/tables', {
      token: a.token,
      json: {
        tables: [
          { code: extra, name: 'A' },
          { code: extra, name: 'B' },
        ],
      },
    });
    expect(duplicate.status).toBe(422);
  });

  it('QR menuyu kapatma (unpublish) menu ve masalari kaldirir, belirtec ve baglanti kalir', async () => {
    const { token } = await activatedBranch();
    const code = tableCode();
    await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    await call('PUT', '/api/pos/tables', { token, json: { tables: [{ code, name: 'Masa 1' }] } });
    expect((await call('GET', `/api/m/${code}`)).status).toBe(200);

    // Belirtecsiz olmaz (Hono: alt yol posAuth'u kendisi tasir).
    const anonymous = await call('POST', '/api/pos/menu/unpublish');
    expect([anonymous.status, anonymous.body.error?.code]).toEqual([401, 'POS_TOKEN_INVALID']);

    const res = await call('POST', '/api/pos/menu/unpublish', { token });
    expect([res.status, res.body.data]).toEqual([200, { unpublished: true }]);
    expect((await call('GET', `/api/m/${code}`)).body.error?.code).toBe('TABLE_NOT_FOUND');
    const status = await call('GET', '/api/pos/status', { token });
    expect([status.status, status.body.data.menu, status.body.data.tableCount]).toEqual([
      200,
      null,
      0,
    ]);
    // Yeniden acinca ayni belirtecle ayni kodlar yayinlanir.
    await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
    await call('PUT', '/api/pos/tables', { token, json: { tables: [{ code, name: 'Masa 1' }] } });
    const again = await call('GET', `/api/m/${code}`);
    expect([again.status, again.body.data.version]).toEqual([200, 1]);
  });

  it('kapatip yeniden acinca ayni masa kodlari yeniden yayinlanir (basili QR calisir)', async () => {
    const licenseKey = await signLicense(licensePayload());
    const installId = unique('inst');
    const code = tableCode();
    const publish = async (token: string) => {
      await call('PUT', '/api/pos/menu', { token, json: sampleMenu() });
      await call('PUT', '/api/pos/tables', { token, json: { tables: [{ code, name: 'Masa 1' }] } });
    };
    const first = await activate({ licenseKey, installId });
    await publish(first.body.data.token);
    expect((await call('GET', `/api/m/${code}`)).status).toBe(200);

    await call('POST', '/api/pos/unpair', { token: first.body.data.token });
    expect((await call('GET', `/api/m/${code}`)).body.error?.code).toBe('TABLE_NOT_FOUND');

    const again = await activate({ licenseKey, installId });
    expect(again.status).toBe(201);
    expect(again.body.data.token).not.toBe(first.body.data.token);
    await publish(again.body.data.token);
    const menu = await call('GET', `/api/m/${code}`);
    expect([menu.status, menu.body.data.version]).toEqual([200, 1]);
  });
});

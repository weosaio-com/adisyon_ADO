import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Owner ile giris + katalog/masa fixture'lari (API) + owner storageState uret.
// Testler bunlari kullanir; boylece UI login ve seed'e bagimli degil.
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const BASE = `${ORIGIN}/api/v1`;
const OWNER_USER = process.env.SEED_OWNER_USERNAME ?? 'owner';
const OWNER_PASS = process.env.SEED_OWNER_PASSWORD ?? 'owner1234';

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T } & Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return (json.data ?? json) as T;
}

export default async function globalSetup(): Promise<void> {
  const login = await call<{
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
    permissions: string[];
  }>('POST', '/auth/login', { username: OWNER_USER, password: OWNER_PASS });
  const token = login.accessToken;
  const user = { ...login.user, permissions: login.permissions ?? [] };

  // Is kurali: kasa oturumu kapaliyken yeni adisyon acilmaz (arayuz + sunucu).
  // Gercek serviste oldugu gibi oturumu ac; zaten aciksa (409) sorun degil.
  const cash = await fetch(`${BASE}/cash/sessions/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ openingFloat: 0 }),
  });
  if (!cash.ok && cash.status !== 409) {
    throw new Error(`POST /cash/sessions/open -> ${cash.status} ${await cash.text()}`);
  }

  const tag = Date.now();
  const unit = await call<{ id: string }>('POST', '/units', { name: `Adet${tag}`, abbreviation: 'ad' }, token); // prettier-ignore
  const tax = await call<{ id: string }>(
    'POST',
    '/taxes',
    { name: `KDV${tag}`, ratePermille: 100 },
    token,
  );
  const cat = await call<{ id: string }>(
    'POST',
    '/categories',
    { name: `E2E Kategori ${tag}` },
    token,
  );
  const product = await call<{ id: string; name: string }>(
    'POST',
    '/products',
    { name: `E2E Cay ${tag}`, categoryId: cat.id, unitId: unit.id, taxId: tax.id, salePrice: 1500 },
    token,
  );
  const hall = await call<{ id: string }>('POST', '/halls', { name: `E2E Salon ${tag}` }, token);
  const table = await call<{ id: string; name: string }>(
    'POST',
    '/tables',
    { hallId: hall.id, name: `E2E Masa ${tag}` },
    token,
  );

  writeFileSync(
    join(here, '.fixtures.json'),
    JSON.stringify(
      {
        categoryId: cat.id,
        productId: product.id,
        productName: product.name,
        tableId: table.id,
        tableName: table.name,
      },
      null,
      2,
    ),
  );

  const storagePath = join(here, '.auth', 'owner.json');
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(
    storagePath,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: ORIGIN,
          localStorage: [
            { name: 'ado.access', value: token },
            { name: 'ado.refresh', value: login.refreshToken },
            { name: 'ado.user', value: JSON.stringify(user) },
          ],
        },
      ],
    }),
  );
}

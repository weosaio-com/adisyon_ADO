// Tablet/kasa e2e'lerinin ortak API yardimcilari: veriyi API ile kurar (arayuz girisine bagli degil).
import type { Browser, BrowserContext, Page } from '@playwright/test';

export const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
export const API = `${ORIGIN}/api/v1`;
const OWNER = {
  username: process.env.SEED_OWNER_USERNAME ?? 'owner',
  password: process.env.SEED_OWNER_PASSWORD ?? 'owner1234',
};

export interface Named {
  id: string;
  name: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; displayName?: string; role?: string };
  permissions: string[];
}

/** JSON istek; 2xx degilse hata firlatir. Zarfin icindeki veri doner. */
export async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(API + path, {
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

export async function ownerLogin(): Promise<LoginResult> {
  return call<LoginResult>('POST', '/auth/login', OWNER);
}

/** Kasa oturumu acik olsun (zaten aciksa 409 sorun degil). */
export async function ensureCashOpen(token: string): Promise<void> {
  const res = await fetch(`${API}/cash/sessions/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ openingFloat: 0 }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`kasa acilamadi: ${res.status}`);
}

let seq = 0;
/** Kendi kategori/urun/salon/masalari: diger spec'lerin verisine dokunmaz. */
export async function makeFixtures(
  token: string,
  opts: { products?: number[]; tables?: number } = {},
): Promise<{ tag: string; categoryId: string; hall: Named; products: Named[]; tables: Named[] }> {
  const tag = `${Date.now()}-${seq++}`;
  const unit = await call<Named>(
    'POST',
    '/units',
    { name: `Adet${tag}`, abbreviation: 'ad' },
    token,
  );
  const tax = await call<Named>('POST', '/taxes', { name: `KDV${tag}`, ratePermille: 100 }, token);
  const cat = await call<Named>('POST', '/categories', { name: `E2E Tablet ${tag}` }, token);
  const products: Named[] = [];
  for (const [i, salePrice] of (opts.products ?? [1500]).entries()) {
    products.push(
      await call<Named>(
        'POST',
        '/products',
        {
          name: `E2E Ürün${i} ${tag}`,
          categoryId: cat.id,
          unitId: unit.id,
          taxId: tax.id,
          salePrice,
        },
        token,
      ),
    );
  }
  const hall = await call<Named>('POST', '/halls', { name: `E2E Salon ${tag}` }, token);
  const tables: Named[] = [];
  for (let i = 0; i < (opts.tables ?? 1); i++) {
    tables.push(
      await call<Named>('POST', '/tables', { hallId: hall.id, name: `T${i + 1} ${tag}` }, token),
    );
  }
  return { tag, categoryId: cat.id, hall, products, tables };
}

/** Benzersiz PIN'li garson (PIN_TAKEN cakisirsa yeniden dener) + PIN ile giris. */
export async function makeWaiter(
  token: string,
  name = 'E2E Garson',
): Promise<{ id: string; username: string; pin: string; login: LoginResult }> {
  for (let attempt = 0; ; attempt++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    const username = `garson-${Date.now()}-${seq++}`;
    try {
      const user = await call<{ id: string }>(
        'POST',
        '/users',
        { username, displayName: name, role: 'waiter', pin },
        token,
      );
      const login = await call<LoginResult>('POST', '/auth/login-pin', { username, pin });
      return { id: user.id, username, pin, login };
    } catch (err) {
      if (attempt > 3 || !String(err).includes('PIN_TAKEN')) throw err;
    }
  }
}

/** Verilen oturumla acilmis tarayici baglami (tablet). */
export async function sessionContext(
  browser: Browser,
  login: LoginResult,
  viewport = { width: 1180, height: 820 },
): Promise<BrowserContext> {
  const user = { ...login.user, permissions: login.permissions ?? [] };
  return browser.newContext({
    viewport,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: ORIGIN,
          localStorage: [
            { name: 'ado.access', value: login.accessToken },
            { name: 'ado.refresh', value: login.refreshToken },
            { name: 'ado.user', value: JSON.stringify(user) },
          ],
        },
      ],
    },
  });
}

/** IndexedDB (ado-offline) deposundaki kayit sayisi. */
export function idbCount(page: Page, store: string): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('ado-offline');
        req.onsuccess = () => {
          try {
            const count = req.result.transaction(name, 'readonly').objectStore(name).count();
            count.onsuccess = () => resolve(count.result);
            count.onerror = () => resolve(-1);
          } catch {
            resolve(-1);
          }
        };
        req.onerror = () => resolve(-1);
      }),
    store,
  );
}

/** Cevrimdisi gosterim icin snapshot IndexedDB'ye yazilmis ve SW sayfayi kontrol ediyor. */
export async function waitOfflineReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open('ado-offline');
        req.onsuccess = () => {
          try {
            const get = req.result
              .transaction('meta', 'readonly')
              .objectStore('meta')
              .get('snapshot');
            get.onsuccess = () =>
              resolve(Boolean((get.result as { data?: unknown } | undefined)?.data));
            get.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        };
        req.onerror = () => resolve(false);
      }),
    undefined,
    { timeout: 20_000, polling: 500 },
  );
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
    timeout: 20_000,
  });
}

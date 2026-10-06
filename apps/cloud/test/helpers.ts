import { exports } from 'cloudflare:workers';
import type { MenuSnapshotInput } from '@ado/shared/menu';

// Worker'in fetch'i (ayni isolate'te, gercek D1/R2 baglamalariyla).
const worker = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } })
  .default;

export const ORIGIN = 'https://qr.example';
export const ADMIN_TOKEN = 'test-admin-token-0123456789';

export interface ApiBody<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface CallOptions {
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  token?: string;
  cookie?: string;
  admin?: boolean;
  ip?: string;
}

export function request(method: string, path: string, opts: CallOptions = {}): Promise<Response> {
  // Tarayici gibi: ayni kokenden gelen istek Origin tasir (panelin CSRF korumasi buna bakar).
  const headers = new Headers({ Origin: ORIGIN, ...opts.headers });
  if (opts.json !== undefined) headers.set('Content-Type', 'application/json');
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (opts.admin) headers.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
  if (opts.cookie) headers.set('Cookie', opts.cookie);
  if (opts.ip) headers.set('CF-Connecting-IP', opts.ip);
  return worker.fetch(
    new Request(ORIGIN + path, {
      method,
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : (opts.body ?? null),
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call<T = any>(method: string, path: string, opts: CallOptions = {}) {
  const res = await request(method, path, opts);
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: (text ? JSON.parse(text) : null) as ApiBody<T>,
  };
}

let seq = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;

export async function createTenant(opts: { plan?: string; password?: string } = {}) {
  const email = `${unique('owner')}@example.com`;
  const password = opts.password ?? 'dogru-parola-123';
  const res = await call<{ tenantId: string; branchId: string; userId: string }>(
    'POST',
    '/api/admin/tenants',
    {
      admin: true,
      json: { name: 'Kebapçı Halil', plan: opts.plan ?? 'menu', owner: { email, password } },
    },
  );
  if (res.status !== 201) throw new Error(`tenant: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body.data, email, password };
}

/** Giris yapar; sonraki isteklerde kullanilacak Cookie basligini dondurur. */
export async function login(email: string, password: string): Promise<string> {
  const res = await request('POST', '/api/panel/login', {
    json: { email, password },
    ip: unique('ip'),
  });
  if (res.status !== 200) throw new Error(`login: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('Set-Cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

export async function pairPos(cookie: string, branchId: string): Promise<string> {
  const code = await call<{ code: string }>(
    'POST',
    `/api/panel/branches/${branchId}/pairing-code`,
    {
      cookie,
    },
  );
  const res = await call<{ token: string }>('POST', '/api/pos/pair', {
    json: { code: code.body.data.code },
    ip: unique('ip'),
  });
  if (res.status !== 201) throw new Error(`pair: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

export function sampleMenu(imageKey: string | null = null): MenuSnapshotInput {
  return {
    schemaVersion: 1,
    branch: { name: 'Kebapçı Halil', languages: ['tr', 'en'] },
    categories: [{ id: 'cat-soup', name: 'Çorbalar', translations: { en: { name: 'Soups' } } }],
    products: [
      {
        id: 'prod-lentil',
        categoryId: 'cat-soup',
        name: 'Mercimek',
        price: 12000,
        imageKey,
        allergens: ['gluten'],
        available: true,
      },
    ],
  };
}

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Gecerli PNG imzali, her cagrida farkli icerikli (farkli anahtarli) gorsel. */
export function png(): Uint8Array {
  const base = Uint8Array.from(atob(PNG_1X1), (char) => char.charCodeAt(0));
  const extra = new TextEncoder().encode(unique('seed'));
  const out = new Uint8Array(base.length + extra.length);
  out.set(base);
  out.set(extra, base.length);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

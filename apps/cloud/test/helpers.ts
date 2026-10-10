import { env, exports } from 'cloudflare:workers';
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

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Test anahtariyla (vitest.config.ts) ya da verilen PKCS8 anahtarla lisans imzalar. */
export async function signLicense(
  payload: Record<string, unknown>,
  privateKeyB64: string = env.TEST_LICENSE_PRIVATE_KEY,
): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(privateKeyB64), (char) => char.charCodeAt(0)),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, raw));
  return `ADO1.${toBase64Url(raw)}.${toBase64Url(signature)}`;
}

/** QR menulu, uzak gelecekte biten gecerli lisans payload'i. */
export function licensePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: unique('lic'),
    c: 'Kebapçı Halil',
    exp: '2099-01-01',
    g: 14,
    f: { 'qr.menu': true },
    ...overrides,
  };
}

export interface ActivateResult {
  token: string;
  branch: { id: string; name: string };
  tenant: {
    name: string;
    status: string;
    plan: string;
    planLabel: string;
    features: Record<string, boolean>;
  };
  license: { id: string; expiresAt: string } | null;
}

export async function activate(
  opts: {
    licenseKey?: string;
    installId?: string;
    takeover?: boolean;
    ip?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return call<ActivateResult>('POST', '/api/pos/activate', {
    json: {
      licenseKey: opts.licenseKey ?? (await signLicense(licensePayload())),
      installId: opts.installId ?? unique('inst'),
      ...(opts.takeover ? { takeover: true } : {}),
    },
    ip: opts.ip ?? unique('ip'),
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
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

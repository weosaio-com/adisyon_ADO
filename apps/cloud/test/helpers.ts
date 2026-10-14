import { env, exports } from 'cloudflare:workers';
import { encodeTableCode, TABLE_CODE_BYTES, type MenuSnapshotInput } from '@ado/shared/menu';

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
  admin?: boolean;
  ip?: string;
}

export function request(method: string, path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers({ Origin: ORIGIN, ...opts.headers });
  if (opts.json !== undefined) headers.set('Content-Type', 'application/json');
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (opts.admin) headers.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
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

/** Lisansla acilmis sube: POS belirteci, sube, isletme ve lisans kimlikleri. */
export async function activatedBranch(payload: Record<string, unknown> = {}) {
  const res = await activate({ licenseKey: await signLicense(licensePayload(payload)) });
  if (res.status !== 201) throw new Error(`activate: ${res.status} ${JSON.stringify(res.body)}`);
  const row = await env.DB.prepare('SELECT tenant_id FROM branches WHERE id = ?')
    .bind(res.body.data.branch.id)
    .first<{ tenant_id: string }>();
  if (!row || !res.body.data.license) throw new Error('activate: sube ya da lisans yok');
  return {
    token: res.body.data.token,
    branchId: res.body.data.branch.id,
    tenantId: row.tenant_id,
    licenseId: res.body.data.license.id,
  };
}

/** POS heartbeat govdesi (bilinmeyen deger null; alan atlanmaz). */
export function heartbeatBody(overrides: Record<string, unknown> = {}) {
  return {
    appVersion: '0.4.0',
    dbBytes: 12_345_678,
    backupsBytes: 45_000_000,
    freeDiskBytes: 50_000_000_000,
    lastBackupAt: '2026-10-14T06:00:01.000Z',
    lastCloudBackupAt: null,
    licenseId: null,
    licenseExp: null,
    ...overrides,
  };
}

export async function heartbeat(
  token: string | undefined,
  overrides: Record<string, unknown> = {},
) {
  return call('POST', '/api/pos/heartbeat', {
    ...(token ? { token } : {}),
    json: heartbeatBody(overrides),
  });
}

/** Lisans kaydi satiri (0004 licenses); yoksa null. */
export async function registryRow(id: string) {
  return env.DB.prepare('SELECT * FROM licenses WHERE id = ?')
    .bind(id)
    .first<Record<string, string | number | null>>();
}

/** Satici API'siyle lisans kaydeder (PUT /api/admin/licenses). */
export async function registerLicense(licenseKey: string, notes?: string) {
  return call('PUT', '/api/admin/licenses', {
    admin: true,
    json: { licenseKey, ...(notes !== undefined ? { notes } : {}) },
  });
}

/** Benzersiz, gecerli masa kodu (QR'daki /m/<kod>; POS uretir). */
export function tableCode(): string {
  return encodeTableCode(crypto.getRandomValues(new Uint8Array(TABLE_CODE_BYTES)));
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

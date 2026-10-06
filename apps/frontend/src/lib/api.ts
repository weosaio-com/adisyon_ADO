// Backend istemcisi: JWT ekle, {success,data,meta} zarfini ac, 401'de bir kez refresh dene.
const BASE = '/api/v1';
const ACCESS_KEY = 'ado.access';
const REFRESH_KEY = 'ado.refresh';
const USER_KEY = 'ado.user';

export interface AuthUser {
  id: string;
  username: string;
  displayName?: string;
  role?: string;
  permissions: string[];
}

export function hasPerm(key: string): boolean {
  return getUser()?.permissions?.includes(key) ?? false;
}

export function getAccess(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}
export function getUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}
export function isAuthed(): boolean {
  return !!getAccess();
}

function setSession(accessToken: string, refreshToken: string, user: AuthUser): void {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

// Alanlar acikca atanir: `public status` gibi parametre-ozellikleri node'un
// strip-only TS modunda calismaz, self-check bu dosyayi import edemez.
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Zarf {success,data}: data NULL olabilir (orn. acik kasa oturumu yokken
// /reports/shift). `json?.data ?? json` null'i atlayip ZARFIN KENDISINI dondurur;
// null bekleyen ekran truthy nesne gorup patlar (beyaz ekran). Bu yuzden
// varlik degil, anahtar kontrolu yapilir.
export function unwrapEnvelope(json: unknown): unknown {
  return json && typeof json === 'object' && 'data' in json
    ? (json as { data: unknown }).data
    : json;
}

async function parse<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error ?? json;
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? res.statusText);
  }
  return unwrapEnvelope(json) as T;
}

async function refresh(): Promise<boolean> {
  const rt = localStorage.getItem(REFRESH_KEY);
  if (!rt) return false;
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  });
  if (!res.ok) return false;
  const data = (await res.json())?.data ?? {};
  if (!data.accessToken) return false;
  localStorage.setItem(ACCESS_KEY, data.accessToken);
  if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
  return true;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; file?: Blob } = {},
  retry = true,
): Promise<T> {
  const access = getAccess();
  const res = await fetch(BASE + path, {
    method: opts.method ?? (opts.file ? 'POST' : 'GET'),
    headers: {
      // file: ham dosya govdesi (orn. yedek yukleme); aksi halde JSON.
      'Content-Type': opts.file ? 'application/octet-stream' : 'application/json',
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    },
    ...(opts.file
      ? { body: opts.file }
      : opts.body !== undefined
        ? { body: JSON.stringify(opts.body) }
        : {}),
  });
  if (res.status === 401 && retry && (await refresh())) {
    return api<T>(path, opts, false);
  }
  if (res.status === 401) {
    clearSession();
  }
  return parse<T>(res);
}

/** Urun gorselinin adresi (herkese acik, suresiz onbellekli; anahtar icerik ozetidir). */
export function catalogImageUrl(key: string): string {
  return `${BASE}/catalog/images/${encodeURIComponent(key)}`;
}

/** Dosya yukle (application/octet-stream); JWT + 401'de refresh api() ile ayni. */
export function apiUpload<T = unknown>(path: string, file: Blob): Promise<T> {
  return api<T>(path, { method: 'POST', file });
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; displayName?: string; role?: string };
  permissions: string[];
}

function sessionUser(r: LoginResult): AuthUser {
  // permissions ust seviyeden gelir; kullanici nesnesine katilir.
  return { ...r.user, permissions: r.permissions ?? [] };
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const r = await api<LoginResult>('/auth/login', { method: 'POST', body: { username, password } });
  const user = sessionUser(r);
  setSession(r.accessToken, r.refreshToken, user);
  return user;
}

export async function loginPin(username: string, pin: string): Promise<AuthUser> {
  const r = await api<LoginResult>('/auth/login-pin', { method: 'POST', body: { username, pin } });
  const user = sessionUser(r);
  setSession(r.accessToken, r.refreshToken, user);
  return user;
}

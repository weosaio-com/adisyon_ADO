// Backend istemcisi: JWT ekle, {success,data,meta} zarfini ac, 401'de belirteci bir kez yenile.
// Her istegin suresi sinirlidir (takilan istek ekrani kilitlemesin). Oturum yalniz /auth/refresh
// 401/403 donerse silinir ve uygulama giris ekranina gecer (SESSION_EXPIRED_EVENT, App dinler);
// ag hatasi, zaman asimi, 5xx ve 503 DB_BUSY oturumu silmez.
const BASE = '/api/v1';
const ACCESS_KEY = 'ado.access';
const REFRESH_KEY = 'ado.refresh';
const USER_KEY = 'ado.user';

/** Normal JSON isteklerinin suresi. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Dosya yukleme, yedek alma / geri yukleme / ice aktarma ve bulut yedegi: uzun surebilir. */
export const LONG_REQUEST_TIMEOUT_MS = 30 * 60_000;

export const TIMEOUT_CODE = 'TIMEOUT';
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
export const DB_BUSY_CODE = 'DB_BUSY';
export const SESSION_EXPIRED_CODE = 'SESSION_EXPIRED';

export const BUSY_MESSAGE = 'Sistem şu an meşgul, birkaç saniye sonra tekrar deneyin.';
export const TIMEOUT_MESSAGE =
  'Sunucu zamanında yanıt vermedi; bağlantıyı kontrol edip tekrar deneyin.';
export const NETWORK_MESSAGE = 'Sunucuya ulaşılamadı; bağlantıyı kontrol edip tekrar deneyin.';
export const SESSION_EXPIRED_MESSAGE = 'Oturumunuz sona erdi; lütfen yeniden giriş yapın.';

/** Oturum gercekten bitti (belirtecler silindi): uygulama giris ekranina gecer. */
export const SESSION_EXPIRED_EVENT = 'session-expired';

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
  /** Gecici hata (ag, zaman asimi, 5xx, DB_BUSY): ayni istek biraz sonra tekrar denenebilir. */
  retryable: boolean;
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Sunucuya hic ulasilamadi (ag hatasi / zaman asimi): cevrimdisi yollar (snapshot) bunu kullanir. */
export function isConnectivityError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 0 &&
    (error.code === NETWORK_ERROR_CODE || error.code === TIMEOUT_CODE)
  );
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

// Lisans kilidi: yeni adisyon 403 LICENSE_LOCKED ile durunca (hangi ekrandan olursa olsun) ya da
// uyari seridinin dugmesiyle lisans penceresi acilir (components/LicenseLockDialog dinler).
export const LICENSE_LOCKED_EVENT = 'license-locked';
export const LICENSE_LOCKED_CODE = 'LICENSE_LOCKED';

export function openLicenseDialog(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LICENSE_LOCKED_EVENT));
}

interface Reply {
  status: number;
  statusText: string;
  json: unknown;
}

const isOk = (status: number) => status >= 200 && status < 300;

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return {};
  }
}

// Hata zarfi { success:false, error:{ code, message, details? } }; zarfsiz govde de okunur.
function errorBody(json: unknown): { code?: unknown; message?: unknown } | null {
  const body = json as { error?: unknown } | null;
  const err = body && typeof body === 'object' && body.error ? body.error : json;
  return err && typeof err === 'object' ? (err as { code?: unknown; message?: unknown }) : null;
}

function errorCode(json: unknown): string {
  const code = errorBody(json)?.code;
  return typeof code === 'string' && code ? code : 'ERROR';
}

function toError(reply: Reply): ApiError {
  const code = errorCode(reply.json);
  if (reply.status === 403 && code === LICENSE_LOCKED_CODE) openLicenseDialog();
  // Veritabani kisa sure mesgul (backend 503 DB_BUSY): oturuma dokunulmaz, tekrar denenebilir.
  if (code === DB_BUSY_CODE) return new ApiError(reply.status, code, BUSY_MESSAGE, true);
  const message = errorBody(reply.json)?.message;
  return new ApiError(
    reply.status,
    code,
    typeof message === 'string' && message ? message : reply.statusText,
    reply.status >= 500 || reply.status === 429,
  );
}

// fetch + govdenin okunmasi birlikte sureye tabidir (basliktan sonra takilan govde de kesilir).
// Ag hatasi NETWORK_ERROR, sure dolmasi TIMEOUT kodlu ApiError olur (status 0, tekrar denenebilir).
async function exchange(url: string, init: RequestInit, timeoutMs: number): Promise<Reply> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, statusText: res.statusText, json: parseJson(text) };
  } catch {
    if (controller.signal.aborted) throw new ApiError(0, TIMEOUT_CODE, TIMEOUT_MESSAGE, true);
    throw new ApiError(0, NETWORK_ERROR_CODE, NETWORK_MESSAGE, true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const sessionExpiredError = () => new ApiError(401, SESSION_EXPIRED_CODE, SESSION_EXPIRED_MESSAGE);

/** Oturum gercekten bitti: belirtecleri sil, uygulamaya bildir (giris ekranina yonlendirilir). */
function endSession(): void {
  clearSession();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

let refreshing: Promise<void> | null = null;

async function refreshTokens(): Promise<void> {
  const rt = localStorage.getItem(REFRESH_KEY);
  if (!rt) {
    endSession();
    throw sessionExpiredError();
  }
  let reply: Reply;
  try {
    reply = await exchange(
      `${BASE}/auth/refresh`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      },
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    // Ag hatasi / zaman asimi: oturum korunur.
    const code = error instanceof ApiError ? error.code : NETWORK_ERROR_CODE;
    throw new ApiError(0, code, BUSY_MESSAGE, true);
  }
  // Bu arada yeniden giris yapildiysa eski yenilemenin sonucu yeni oturuma dokunmaz.
  if (localStorage.getItem(REFRESH_KEY) !== rt) return;
  if (reply.status === 401 || reply.status === 403) {
    endSession();
    throw sessionExpiredError();
  }
  const data = isOk(reply.status)
    ? (unwrapEnvelope(reply.json) as { accessToken?: unknown; refreshToken?: unknown } | null)
    : null;
  if (!data || typeof data.accessToken !== 'string' || !data.accessToken) {
    // 5xx / 503 DB_BUSY ya da bozuk yanit: oturum korunur, istek biraz sonra tekrar denenir.
    throw new ApiError(reply.status, errorCode(reply.json), BUSY_MESSAGE, true);
  }
  localStorage.setItem(ACCESS_KEY, data.accessToken);
  if (typeof data.refreshToken === 'string' && data.refreshToken) {
    localStorage.setItem(REFRESH_KEY, data.refreshToken);
  }
}

/**
 * 401 alan istegin erisim belirtecini yeniler; `sent` o istegin gonderdigi belirtectir. Ayni anda
 * 401 alan istekler tek /auth/refresh cagrisini paylasir; belirtec bu arada zaten yenilendiyse
 * (ya da yeniden giris yapildiysa) yenileme yapilmaz. Canli olay akisi (SSE) de bunu kullanir.
 */
export async function renewAccess(sent: string): Promise<void> {
  const current = getAccess();
  if (current && current !== sent) return;
  // Oturum bu arada kapandi (baska istegin yenilemesi reddedildi ya da cikis yapildi): olay
  // zaten yayildi / kullanici zaten giris ekraninda; yeniden yayilmaz.
  if (!current) throw sessionExpiredError();
  refreshing ??= refreshTokens().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  file?: Blob;
  /** ms; verilmezse dosya yuklemede LONG_REQUEST_TIMEOUT_MS, aksi halde REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** false: belirtec gonderilmez (giris uclari; hatali sifrenin 401'i oturuma dokunmaz). */
  auth?: boolean;
}

export function requestTimeout(opts: ApiOptions): number {
  return opts.timeoutMs ?? (opts.file ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
}

export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {},
  retry = true,
): Promise<T> {
  const access = opts.auth === false ? null : getAccess();
  const reply = await exchange(
    BASE + path,
    {
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
    },
    requestTimeout(opts),
  );
  // Belirtecle gonderilen istege 401: belirtec yenilenir, istek bir kez tekrarlanir. Belirtecsiz
  // istegin 401'i (orn. hatali sifre) oturumla ilgili degildir, hata olarak aynen doner.
  if (reply.status === 401 && access) {
    if (retry) {
      await renewAccess(access);
      return api<T>(path, opts, false);
    }
    // Yeni belirtec de reddedildi (orn. sunucuda gecici veritabani hatasi): oturum silinmez.
    throw new ApiError(401, errorCode(reply.json), BUSY_MESSAGE, true);
  }
  if (!isOk(reply.status)) throw toError(reply);
  return unwrapEnvelope(reply.json) as T;
}

/** Urun gorselinin adresi (herkese acik, suresiz onbellekli; anahtar icerik ozetidir). */
export function catalogImageUrl(key: string): string {
  return `${BASE}/catalog/images/${encodeURIComponent(key)}`;
}

/** Dosya yukle (application/octet-stream); JWT + 401'de yenileme api() ile ayni, uzun sure. */
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
  const r = await api<LoginResult>('/auth/login', {
    method: 'POST',
    body: { username, password },
    auth: false,
  });
  const user = sessionUser(r);
  setSession(r.accessToken, r.refreshToken, user);
  return user;
}

export async function loginPin(username: string, pin: string): Promise<AuthUser> {
  const r = await api<LoginResult>('/auth/login-pin', {
    method: 'POST',
    body: { username, pin },
    auth: false,
  });
  const user = sessionUser(r);
  setSession(r.accessToken, r.refreshToken, user);
  return user;
}

import type { HeartbeatRequest, MenuSnapshot, MenuTable } from '@ado/shared';

/** Buluttaki POS API'sinin (apps/cloud src/routes/pos.ts) istemcisi. */

/** ApplicationSetting `cloud.connection`: lisansla kendiliginden kurulan baglanti. */
export interface CloudConnection {
  /** Baglanilan bulut (programa gomulu adres; acilista degistiyse baglanti duser). */
  url: string;
  token: string;
  /** Bu kurulumun kimligi (ado-install.json); yedekten baska bilgisayara tasinirsa duser. */
  installId: string;
  /** Acilistaki lisans kimligi; farkli lisans girilirse baglanti yenilenir. */
  licenseId: string;
  branchId: string;
  branchName: string;
  tenantName: string;
  tenantStatus: 'active' | 'suspended';
  planLabel: string;
  features: Record<string, boolean>;
  licenseExpiresAt: string | null;
  pairedAt: string;
}

/** Belirtecle yapilan istekler icin (bekleyen kapatma eski baglantinin adresini/belirtecini tasir). */
export type CloudAuth = Pick<CloudConnection, 'url' | 'token'>;

/** Diger modullerin (bulut yedegi vb.) gordugu baglanti: yalniz istek atmaya yetenler. */
export type CloudLink = Pick<
  CloudConnection,
  'url' | 'token' | 'installId' | 'licenseId' | 'features'
>;

export interface PosInfo {
  branch: { id: string; name: string };
  tenant: {
    name: string;
    status: 'active' | 'suspended';
    plan: string;
    planLabel: string;
    features: Record<string, boolean>;
  };
  license: { id: string; expiresAt: string | null } | null;
}

export interface ActivateRequest {
  licenseKey: string;
  installId: string;
  posBranchId: string;
  branchName?: string;
  takeover?: boolean;
}

/** Bulut hatasi: `status` 0 ise buluta hic ulasilamadi (ag/DNS/zaman asimi). */
export class CloudError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TIMEOUT_MS = 20_000;

export interface CloudRequestInit {
  method: string;
  token?: string;
  json?: unknown;
  bytes?: Buffer;
  /** Ek basliklar (or. bulut yedeginin meta verisi). */
  headers?: Record<string, string>;
  /** Varsayilan 20 sn; buyuk yuklemeler daha uzun sure ister. */
  timeoutMs?: number;
}

/**
 * Buluta tek istek: `{success, data}` zarfini acar, hatada CloudError atar (`status` 0 = buluta
 * ulasilamadi). X-Ado-Version her istekte gider. Bulut yedegi gibi baska moduller de kullanir.
 */
export async function cloudRequest<T>(
  baseUrl: string,
  path: string,
  init: CloudRequestInit,
): Promise<T> {
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.bytes;
  // Satici guncelleme yayilimini izler (buluttaki sube kaydina yazilir).
  const version = process.env.ADO_APP_VERSION?.trim();
  let res: Response;
  try {
    res = await fetch(baseUrl + path, {
      method: init.method,
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...(version ? { 'X-Ado-Version': version } : {}),
        ...init.headers,
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CloudError(0, 'CLOUD_UNREACHABLE', `Buluta ulaşılamadı (${reason}).`);
  }
  const text = await res.text();
  let parsed: {
    success?: boolean;
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // JSON degil (ornegin vekil sunucu hata sayfasi): asagida genel hata.
  }
  if (!res.ok || !parsed.success) {
    throw new CloudError(
      res.status,
      parsed.error?.code ?? 'CLOUD_ERROR',
      parsed.error?.message ?? `Bulut beklenmeyen yanıt verdi (HTTP ${res.status}).`,
      parsed.error?.details,
    );
  }
  return parsed.data as T;
}

export const cloudApi = {
  activate: (url: string, body: ActivateRequest) =>
    cloudRequest<PosInfo & { token: string }>(url, '/api/pos/activate', {
      method: 'POST',
      json: body,
    }),

  refreshLicense: (auth: CloudAuth, licenseKey: string) =>
    cloudRequest<PosInfo>(auth.url, '/api/pos/license', {
      method: 'PUT',
      token: auth.token,
      json: { licenseKey },
    }),

  /** Eski bulut (heartbeat yok) icin: isletme durumu, menu ve masa sayisi. */
  status: (auth: CloudAuth) =>
    cloudRequest<PosInfo & { menu: { version: number } | null; tableCount: number }>(
      auth.url,
      '/api/pos/status',
      { method: 'GET', token: auth.token },
    ),

  /** Saatlik heartbeat; yanit @ado/shared heartbeatResponseSchema ile dogrulanir (cagiranda). */
  heartbeat: (auth: CloudAuth, body: HeartbeatRequest) =>
    cloudRequest<unknown>(auth.url, '/api/pos/heartbeat', {
      method: 'POST',
      token: auth.token,
      json: body,
    }),

  /** "QR menuyu kapat": menu ve masalar kalkar, baglanti kalir. */
  unpublish: (auth: CloudAuth) =>
    cloudRequest<{ unpublished: boolean }>(auth.url, '/api/pos/menu/unpublish', {
      method: 'POST',
      token: auth.token,
    }),

  checkImages: (auth: CloudAuth, keys: string[]) =>
    cloudRequest<{ missing: string[] }>(auth.url, '/api/pos/images/check', {
      method: 'POST',
      token: auth.token,
      json: { keys },
    }),

  putImage: (auth: CloudAuth, key: string, bytes: Buffer) =>
    cloudRequest<{ key: string }>(auth.url, `/api/pos/images/${key}`, {
      method: 'PUT',
      token: auth.token,
      bytes,
    }),

  putMenu: (auth: CloudAuth, menu: MenuSnapshot) =>
    cloudRequest<{ version: number; updatedAt: string }>(auth.url, '/api/pos/menu', {
      method: 'PUT',
      token: auth.token,
      json: menu,
    }),

  putTables: (auth: CloudAuth, tables: MenuTable[]) =>
    cloudRequest<{ count: number }>(auth.url, '/api/pos/tables', {
      method: 'PUT',
      token: auth.token,
      json: { tables },
    }),

  /** Eski baglantiyi bulutta kapatir (belirtec iptal; farkli lisans, adres degisti). */
  unpair: (auth: CloudAuth) =>
    cloudRequest<{ unpaired: boolean }>(auth.url, '/api/pos/unpair', {
      method: 'POST',
      token: auth.token,
    }),
};

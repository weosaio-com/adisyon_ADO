import type { MenuSnapshot, MenuTable } from '@ado/shared';

/** Buluttaki POS API'sinin (apps/cloud src/routes/pos.ts) istemcisi. */

/** ApplicationSetting `cloud.connection`: lisansla acilan baglanti. */
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

async function request<T>(
  baseUrl: string,
  path: string,
  init: { method: string; token?: string; json?: unknown; bytes?: Buffer },
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
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
    request<PosInfo & { token: string }>(url, '/api/pos/activate', { method: 'POST', json: body }),

  refreshLicense: (auth: CloudAuth, licenseKey: string) =>
    request<PosInfo>(auth.url, '/api/pos/license', {
      method: 'PUT',
      token: auth.token,
      json: { licenseKey },
    }),

  status: (auth: CloudAuth) =>
    request<PosInfo & { menu: { version: number } | null; tableCount: number }>(
      auth.url,
      '/api/pos/status',
      { method: 'GET', token: auth.token },
    ),

  checkImages: (auth: CloudAuth, keys: string[]) =>
    request<{ missing: string[] }>(auth.url, '/api/pos/images/check', {
      method: 'POST',
      token: auth.token,
      json: { keys },
    }),

  putImage: (auth: CloudAuth, key: string, bytes: Buffer) =>
    request<{ key: string }>(auth.url, `/api/pos/images/${key}`, {
      method: 'PUT',
      token: auth.token,
      bytes,
    }),

  putMenu: (auth: CloudAuth, menu: MenuSnapshot) =>
    request<{ version: number; updatedAt: string }>(auth.url, '/api/pos/menu', {
      method: 'PUT',
      token: auth.token,
      json: menu,
    }),

  putTables: (auth: CloudAuth, tables: MenuTable[]) =>
    request<{ count: number }>(auth.url, '/api/pos/tables', {
      method: 'PUT',
      token: auth.token,
      json: { tables },
    }),

  unpair: (auth: CloudAuth) =>
    request<{ unpaired: boolean }>(auth.url, '/api/pos/unpair', {
      method: 'POST',
      token: auth.token,
    }),
};

import type { MenuSnapshot, MenuTable } from '@ado/shared';

/** Buluttaki POS API'sinin (apps/cloud src/routes/pos.ts) istemcisi. */

export interface CloudConnection {
  url: string;
  token: string;
  branchId: string;
  branchName: string;
  tenantName: string;
  planLabel: string;
  features: Record<string, boolean>;
  pairedAt: string;
}

interface PairResult {
  token: string;
  branch: { id: string; name: string };
  tenant: { name: string; planLabel: string; features: Record<string, boolean> };
}

/** Bulut hatasi: `status` 0 ise buluta hic ulasilamadi (ag/DNS/zaman asimi). */
export class CloudError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TIMEOUT_MS = 20_000;

async function request<T>(
  baseUrl: string,
  path: string,
  init: { method: string; token?: string; json?: unknown; bytes?: Buffer },
): Promise<T> {
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.bytes;
  let res: Response;
  try {
    res = await fetch(baseUrl + path, {
      method: init.method,
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CloudError(0, 'CLOUD_UNREACHABLE', `Buluta ulaşılamadı (${reason}).`);
  }
  const text = await res.text();
  let parsed: { success?: boolean; data?: T; error?: { code?: string; message?: string } } = {};
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
    );
  }
  return parsed.data as T;
}

export const cloudApi = {
  pair: (url: string, code: string) =>
    request<PairResult>(url, '/api/pos/pair', { method: 'POST', json: { code } }),

  checkImages: (conn: CloudConnection, keys: string[]) =>
    request<{ missing: string[] }>(conn.url, '/api/pos/images/check', {
      method: 'POST',
      token: conn.token,
      json: { keys },
    }),

  putImage: (conn: CloudConnection, key: string, bytes: Buffer) =>
    request<{ key: string }>(conn.url, `/api/pos/images/${key}`, {
      method: 'PUT',
      token: conn.token,
      bytes,
    }),

  putMenu: (conn: CloudConnection, menu: MenuSnapshot) =>
    request<{ version: number; updatedAt: string }>(conn.url, '/api/pos/menu', {
      method: 'PUT',
      token: conn.token,
      json: menu,
    }),

  putTables: (conn: CloudConnection, tables: MenuTable[]) =>
    request<{ count: number }>(conn.url, '/api/pos/tables', {
      method: 'PUT',
      token: conn.token,
      json: { tables },
    }),

  unpair: (conn: CloudConnection) =>
    request<{ unpaired: boolean }>(conn.url, '/api/pos/unpair', {
      method: 'POST',
      token: conn.token,
    }),
};

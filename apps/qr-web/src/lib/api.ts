import { reportReachable, reportUnreachable } from './connectivity';

// Bulut API istemcisi: zarf { success, data } / { success: false, error }. Oturum cerezde (ayni koken).
export class ApiError extends Error {
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

export async function api<T>(
  path: string,
  opts: { method?: string; json?: unknown; body?: Blob } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.json !== undefined || opts.body ? 'POST' : 'GET'),
      headers:
        opts.json !== undefined
          ? { 'Content-Type': 'application/json' }
          : opts.body
            ? { 'Content-Type': 'application/octet-stream' }
            : {},
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
      ...(opts.body ? { body: opts.body } : {}),
      credentials: 'same-origin',
    });
  } catch {
    reportUnreachable();
    throw new ApiError(0, 'NETWORK', 'Bağlantı kurulamadı.');
  }
  reportReachable();
  const text = await res.text();
  let parsed: {
    success?: boolean;
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // JSON olmayan yanit: asagida genel hata.
  }
  if (!res.ok || !parsed.success) {
    throw new ApiError(
      res.status,
      parsed.error?.code ?? 'ERROR',
      parsed.error?.message ?? `Beklenmeyen yanıt (HTTP ${res.status}).`,
      parsed.error?.details,
    );
  }
  return parsed.data as T;
}

/** Tarayici depolamasi erisilemeyebilir (gizli sekme); hata sayfayi bozmasin. */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // yoksay
    }
  },
};

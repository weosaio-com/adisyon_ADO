// Bulut API istemcisi: zarf { success, data } / { success: false, error }.
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

export async function api<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Bağlantı kurulamadı.');
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

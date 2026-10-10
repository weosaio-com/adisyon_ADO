/**
 * WebCrypto yardimcilari. Gizli degerler (POS belirteci) veritabaninda yalniz SHA-256 ozetiyle durur.
 */
const encoder = new TextEncoder();

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const input = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

/** Tahmin edilemez belirtec (URL guvenli). */
export function randomToken(prefix = '', size = 32): string {
  return prefix + toBase64Url(randomBytes(size));
}

/** Sabit sureli karsilastirma: once ozetlenir, uzunluk farki da sizmaz. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

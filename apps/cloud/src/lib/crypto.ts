/**
 * WebCrypto yardimcilari. Gizli degerler (POS belirteci, oturum, eslestirme kodu) veritabaninda
 * yalniz SHA-256 ozetiyle durur; parolalar PBKDF2-SHA256 ile ozetlenir. Workers PBKDF2'de en fazla
 * 100.000 turu destekler.
 */
const encoder = new TextEncoder();

export const PBKDF2_ITERATIONS = 100_000;

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

export function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const input = typeof data === 'string' ? encoder.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

/** Tahmin edilemez belirtec (URL/cerez guvenli). */
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

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rounds, salt, hash] = stored.split('$');
  const iterations = Number(rounds);
  if (scheme !== 'pbkdf2-sha256' || !salt || !hash) return false;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }
  const expected = fromBase64Url(hash);
  const actual = await pbkdf2(password, fromBase64Url(salt), iterations);
  return expected.length === actual.length && crypto.subtle.timingSafeEqual(actual, expected);
}

/** Kullanici yokken de ayni sure harcanir (e-posta var/yok zamanlamadan anlasilmasin). */
export async function burnPasswordCheck(password: string): Promise<false> {
  await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
  return false;
}

// Eslestirme kodu: 8 karakter (~40 bit), 15 dk gecerli, tek kullanimlik. Karisan harfler yok
// (I, L, O, 0, 1): POS ekranina elle yazilir.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_LENGTH = 8;

export function newPairingCode(): string {
  // 248 = 31 * 8: ustundeki baytlar atilir, her harf esit olasilikli kalir.
  let code = '';
  while (code.length < PAIRING_LENGTH) {
    for (const byte of randomBytes(PAIRING_LENGTH * 2)) {
      if (byte < 248 && code.length < PAIRING_LENGTH) {
        code += PAIRING_ALPHABET.charAt(byte % PAIRING_ALPHABET.length);
      }
    }
  }
  return code;
}

/** Kullanici girisini sadelestirir: "abcd-efgh " -> "ABCDEFGH". */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

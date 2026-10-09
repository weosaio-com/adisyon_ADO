/**
 * Lisans anahtari sozlesmesi — POS (Node) ve bulut (Cloudflare Worker) ayni bicimi okur.
 *
 *   ADO1.<base64url(payload JSON)>.<base64url(ed25519 imza)>
 *
 * Imza payload'in HAM baytlari uzerindedir. Imza dogrulamasi platforma ozgudur (POS'ta
 * `node:crypto`, bulutta WebCrypto); bu dosya yalniz bicimi ve payload semasini tasir.
 * Yalniz `zod`'a baglidir (ulid'e degil): Worker `@ado/shared/license` giris noktasini kullanir.
 * Tasarim: LICENSING.md.
 */
import { z } from 'zod';

export const LICENSE_TAG = 'ADO1';

/** Lisans kimligi: bulutta isletmeyi bu anahtarla tanir. Yenilemede ayni kalir. */
export const LICENSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** QR menuyu acan ozellik bayragi. */
export const QR_MENU_FEATURE = 'qr.menu';

const ED25519_SIGNATURE_BYTES = 64;

export const licensePayloadSchema = z.object({
  /** id — lisans kimligi (bulutta isletme anahtari). Eski lisanslarda yok. */
  id: z.string().regex(LICENSE_ID_PATTERN).optional(),
  /** customer — musteri/isletme adi */
  c: z.string().trim().min(1).max(120),
  /** plan — 'yearly' vb. */
  p: z.string().max(40).optional(),
  /** expires — 'YYYY-MM-DD' (dahil degil: bu gunun basinda biter) */
  exp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** grace — bitisten sonra kac gun uyarili calismaya izin verilir */
  g: z.number().int().min(0).max(366).optional(),
  /** features — ozellik bayraklari ( or. { "qr.menu": true }) */
  f: z.record(z.string(), z.boolean()).optional(),
});

export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/** base64url -> bayt. Gecersiz karakter/bicimde null (atob: Node 16+ ve Worker'da var). */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export interface LicenseKeyParts {
  /** Imzalanan ham payload baytlari. */
  payloadRaw: Uint8Array;
  /** 64 baytlik Ed25519 imzasi. */
  signature: Uint8Array;
}

/** Anahtari parcalarina ayirir; bicim bozuksa null. Imzayi DOGRULAMAZ. */
export function splitLicenseKey(key: string): LicenseKeyParts | null {
  const parts = key.trim().split('.');
  if (parts.length !== 3) return null;
  const [tag, payloadPart, signaturePart] = parts;
  if (tag !== LICENSE_TAG || !payloadPart || !signaturePart) return null;
  const payloadRaw = decodeBase64Url(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!payloadRaw || !signature || signature.length !== ED25519_SIGNATURE_BYTES) return null;
  return { payloadRaw, signature };
}

/** Imzasi dogrulanmis ham payload'i semaya gore okur; gecersizse null. */
export function parseLicensePayload(payloadRaw: Uint8Array): LicensePayload | null {
  try {
    const parsed = licensePayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(payloadRaw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Bulutun kullandigi bitis ani: exp gununun UTC basi + grace gun. POS kendi saat diliminde
 * (yerel gun basi) hesaplar; bulut tum kiracilar icin tek ve tasinabilir bir an ister.
 */
export function licenseExpiresAtUtc(payload: Pick<LicensePayload, 'exp' | 'g'>): Date {
  const [y = 0, m = 1, d = 1] = payload.exp.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Math.max(0, payload.g ?? 0)));
}

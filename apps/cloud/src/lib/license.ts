import {
  licenseExpiresAtUtc,
  parseLicensePayload,
  QR_MENU_FEATURE,
  splitLicenseKey,
  type LicensePayload,
} from '@ado/shared/license';
import type { Env } from '../env';
import { ApiError } from './http';

/**
 * Lisans dogrulamasi (WebCrypto Ed25519). Bicim ve sema programla ortak (@ado/shared/license);
 * program ayni anahtari node:crypto ile dogrular. Tasarim: LICENSING.md.
 */

// Acik anahtar isolate basina bir kez ice aktarilir.
const keyCache = new Map<string, Promise<CryptoKey | null>>();

function importPublicKey(b64: string): Promise<CryptoKey | null> {
  let key = keyCache.get(b64);
  if (!key) {
    key = (async () => {
      try {
        const der = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
        return await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
      } catch {
        return null; // bozuk anahtar: listede siradakine gecilir
      }
    })();
    keyCache.set(b64, key);
  }
  return key;
}

/** Tanimli acik anahtarlar; hic yoksa lisansla etkinlestirme kapalidir (503). */
export function licensePublicKeys(env: Pick<Env, 'LICENSE_PUBLIC_KEY'>): string[] {
  const keys = (env.LICENSE_PUBLIC_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    throw new ApiError(
      503,
      'ACTIVATION_DISABLED',
      'Lisansla bağlanma bu bulutta henüz açık değil.',
    );
  }
  return keys;
}

/** Imzayi listedeki anahtarlarla dogrular; gecerliyse payload, degilse null. */
export async function verifyLicense(
  licenseKey: string,
  publicKeys: string[],
): Promise<LicensePayload | null> {
  const parts = splitLicenseKey(licenseKey);
  if (!parts) return null;
  for (const b64 of publicKeys) {
    const key = await importPublicKey(b64);
    if (!key) continue;
    if (await crypto.subtle.verify({ name: 'Ed25519' }, key, parts.signature, parts.payloadRaw)) {
      return parseLicensePayload(parts.payloadRaw);
    }
  }
  return null;
}

export interface UsableLicense {
  payload: LicensePayload & { id: string };
  expiresAt: string;
}

/**
 * Etkinlestirme ve yenileme icin ortak kontrol: imza, kimlik, sure ve (istenirse) QR menu hakki.
 * Yenileme QR menusuz lisansi da kabul eder: ozellik kapanir, baglanti durur.
 * Hata kodlari POS'ta ayri durumlara karsilik gelir.
 */
export async function requireUsableLicense(
  env: Pick<Env, 'LICENSE_PUBLIC_KEY'>,
  licenseKey: string,
  { requireQrMenu = true, now = new Date() }: { requireQrMenu?: boolean; now?: Date } = {},
): Promise<UsableLicense> {
  const payload = await verifyLicense(licenseKey, licensePublicKeys(env));
  if (!payload) {
    throw new ApiError(400, 'LICENSE_INVALID', 'Lisans anahtarı geçersiz ya da bozuk.');
  }
  if (!payload.id) {
    throw new ApiError(
      400,
      'LICENSE_ID_REQUIRED',
      'Bu lisans QR menü için uygun değil (lisans numarası yok). Satıcınızdan yeni lisans isteyin.',
    );
  }
  const expiresAt = licenseExpiresAtUtc(payload);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(403, 'LICENSE_EXPIRED', 'Lisansın süresi dolmuş.');
  }
  if (requireQrMenu && payload.f?.[QR_MENU_FEATURE] !== true) {
    throw new ApiError(403, 'QR_MENU_NOT_LICENSED', 'Lisansınız QR menüyü içermiyor.');
  }
  return { payload: { ...payload, id: payload.id }, expiresAt: expiresAt.toISOString() };
}

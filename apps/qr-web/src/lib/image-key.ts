import { menuImageKey, sniffImageType } from '@ado/shared/menu-core';

/**
 * Gorsel anahtari tarayicida, buluttaki storeImage ile ayni kuralla hesaplanir:
 * `sha256(icerik).uzanti`. Internet yokken eklenen fotograf menude hemen bu anahtarla yer alir,
 * internet gelince ayni anahtarla yuklenir (icerik adresli: tekrar yukleme zararsiz).
 */
export async function imageKeyForBytes(bytes: Uint8Array): Promise<string | null> {
  const ext = sniffImageType(bytes);
  if (!ext) return null;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return menuImageKey(hex, ext);
}

export async function imageKeyForBlob(blob: Blob): Promise<string | null> {
  return imageKeyForBytes(new Uint8Array(await blob.arrayBuffer()));
}

// Urun gorseli hazirlama (tarayicida): uzun kenar en fazla 800 px, WebP (desteklemeyen
// tarayicida JPEG). Sunucuya ve buluta ~50-150 KB gider; telefonda menu hizli acilir.
import { MENU_IMAGE_MAX_BYTES } from '@ado/shared/menu-core';

export const MENU_IMAGE_MAX_SIDE = 800;

/** Kullaniciya gosterilecek mesajla hata (gorsel okunamadi, cok buyuk vb.). */
export class MenuImageError extends Error {}

/** En-boy oranini koruyarak `maxSide` kutusuna sigdirir; kucuk gorsel buyutulmez. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareMenuImage(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new MenuImageError('Görsel okunamadı. JPEG, PNG ya da WebP bir fotoğraf seçin.');
  }
  const size = fitWithin(bitmap.width, bitmap.height, MENU_IMAGE_MAX_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new MenuImageError('Tarayıcı görseli işleyemedi.');
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();

  let blob = await toBlob(canvas, 'image/webp', 0.82);
  // WebP kodlayamayan tarayici (eski Safari) PNG dondurur: buyuk olmasin diye JPEG'e dus.
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new MenuImageError('Tarayıcı görseli işleyemedi.');
  if (blob.size > MENU_IMAGE_MAX_BYTES) throw new MenuImageError('Görsel 1 MB sınırını aşıyor.');
  return blob;
}

/** Yuklenmemis gorselin onizlemesi (CSP img-src yalniz 'self' ve data: izin verir). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new MenuImageError('Görsel önizlenemedi.'));
    reader.readAsDataURL(blob);
  });
}

// Urun gorseli hazirlama (tarayicida): uzun kenar en fazla 800 px, WebP (desteklemeyen tarayicida
// JPEG). POS arayuzundeki apps/frontend/src/lib/image.ts ile ayni kural; bulut 1 MB ustunu reddeder.
import { MENU_IMAGE_MAX_BYTES } from '@ado/shared/menu-core';

const MAX_SIDE = 800;

export class MenuImageError extends Error {}

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
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height, 1));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new MenuImageError('Tarayıcı görseli işleyemedi.');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let blob = await toBlob(canvas, 'image/webp', 0.82);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new MenuImageError('Tarayıcı görseli işleyemedi.');
  if (blob.size > MENU_IMAGE_MAX_BYTES) throw new MenuImageError('Görsel 1 MB sınırını aşıyor.');
  return blob;
}

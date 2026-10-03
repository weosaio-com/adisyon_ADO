import { useSyncExternalStore } from 'react';
import { deleteImage, getImage, listDrafts, listImageKeys, listImages, putImage } from './store';
import { referencedImageKeys } from './sync-core';

// Buluta henuz yuklenmemis fotograflar cihazdan gosterilir (blob: adresi); yuklenince /img/<anahtar>.
const local = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

/** Acilista cihazdaki bekleyen fotograflari gosterime hazirlar. */
export async function loadPendingImages(): Promise<void> {
  const keys = await listImageKeys();
  for (const key of keys) {
    if (local.has(key)) continue;
    const stored = await getImage(key);
    if (stored) local.set(key, URL.createObjectURL(stored.blob));
  }
  if (keys.length) changed();
}

export async function keepPendingImage(key: string, blob: Blob): Promise<void> {
  await putImage(key, blob);
  if (!local.has(key)) {
    local.set(key, URL.createObjectURL(blob));
    changed();
  }
}

/** Fotograf buluta yuklendi: cihazdaki kopya silinir, gosterim /img/'e doner. */
export async function dropPendingImage(key: string): Promise<void> {
  await deleteImage(key);
  const url = local.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    local.delete(key);
    changed();
  }
}

export const isPendingImage = (key: string) => local.has(key);

/**
 * Hicbir taslagin kullanmadigi bekleyen fotograflari siler (urunden kaldirilan, vazgecilen).
 * Son eklenenlere dokunmaz: acik urun penceresindeki fotograf henuz taslakta olmayabilir.
 */
export async function prunePendingImages(): Promise<void> {
  const [images, drafts] = await Promise.all([listImages(), listDrafts()]);
  const used = new Set(drafts.flatMap((draft) => referencedImageKeys(draft.menu)));
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const image of images) {
    if (!used.has(image.key) && Date.parse(image.createdAt) < cutoff) {
      await dropPendingImage(image.key);
    }
  }
}

export function forgetAllPendingImages(): void {
  local.forEach((url) => URL.revokeObjectURL(url));
  local.clear();
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useImageSrc(key: string | null): string | null {
  useSyncExternalStore(subscribe, () => version);
  return key ? (local.get(key) ?? `/img/${key}`) : null;
}

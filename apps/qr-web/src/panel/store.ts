import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MenuSnapshot } from '@ado/shared/menu';

/**
 * Panelin cihazdaki deposu (IndexedDB): son menu/masa sorgulari, yayinlanmamis taslaklar ve
 * buluta henuz yuklenmemis fotograflar. Internet yokken panel bunlarla acilir; cikista silinir.
 * Depo acilamazsa (gizli sekme vb.) panel internetle eskisi gibi calisir, yalniz cihazda saklamaz.
 */
export interface StoredDraft {
  branchId: string;
  menu: MenuSnapshot;
  baseVersion: number | null;
  /** "Kaydet ve yayinla" basildi, henuz yayinlanmadi (internet gelince gonderilir). */
  publishPending: boolean;
  updatedAt: string;
}

export interface StoredImage {
  key: string;
  blob: Blob;
  createdAt: string;
}

interface PanelDB extends DBSchema {
  kv: { key: string; value: unknown };
  drafts: { key: string; value: StoredDraft };
  images: { key: string; value: StoredImage };
}

let opening: Promise<IDBPDatabase<PanelDB> | null> | null = null;

function db(): Promise<IDBPDatabase<PanelDB> | null> {
  opening ??= openDB<PanelDB>('ado-panel', 1, {
    upgrade(database) {
      database.createObjectStore('kv');
      database.createObjectStore('drafts', { keyPath: 'branchId' });
      database.createObjectStore('images', { keyPath: 'key' });
    },
  }).catch(() => null);
  return opening;
}

// Depo hatasi paneli durdurmasin: okuma bos doner, yazma sessizce atlanir.
async function safely<T>(run: (database: IDBPDatabase<PanelDB>) => Promise<T>, fallback: T) {
  try {
    const database = await db();
    return database ? await run(database) : fallback;
  } catch {
    return fallback;
  }
}

export const kvGet = <T>(key: string) =>
  safely(async (d) => (await d.get('kv', key)) as T | undefined, undefined);
export const kvSet = (key: string, value: unknown) =>
  safely(async (d) => void (await d.put('kv', value, key)), undefined);
export const kvDelete = (key: string) => safely((d) => d.delete('kv', key), undefined);

export const loadDraft = (branchId: string) => safely((d) => d.get('drafts', branchId), undefined);
export const saveDraft = (draft: StoredDraft) =>
  safely(async (d) => void (await d.put('drafts', draft)), undefined);
export const deleteDraft = (branchId: string) =>
  safely((d) => d.delete('drafts', branchId), undefined);
export const listDrafts = () => safely((d) => d.getAll('drafts'), [] as StoredDraft[]);

export const putImage = (key: string, blob: Blob) =>
  safely(
    async (d) => void (await d.put('images', { key, blob, createdAt: new Date().toISOString() })),
    undefined,
  );
export const getImage = (key: string) => safely((d) => d.get('images', key), undefined);
export const deleteImage = (key: string) => safely((d) => d.delete('images', key), undefined);
export const listImageKeys = () => safely((d) => d.getAllKeys('images'), [] as string[]);
export const listImages = () => safely((d) => d.getAll('images'), [] as StoredImage[]);

/** Cihazdaki tum panel verisi (cikista ve baska hesap girince). */
export const clearAll = () =>
  safely(async (d) => {
    const tx = d.transaction(['kv', 'drafts', 'images'], 'readwrite');
    await Promise.all([
      tx.objectStore('kv').clear(),
      tx.objectStore('drafts').clear(),
      tx.objectStore('images').clear(),
      tx.done,
    ]);
  }, undefined);

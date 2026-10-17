import { statfs } from 'node:fs/promises';
import type { DiskSpace } from './backup.retention';

/**
 * Verilen yolun bulundugu surucunun bos/toplam alani (bayt). Okunamazsa null: saklama normal
 * kurallarla calisir, ekranda "bilinmiyor" gorunur. Bos alan = kullanicinin yazabilecegi alan.
 */
export async function readDiskSpace(path: string): Promise<DiskSpace | null> {
  try {
    const stats = await statfs(path);
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

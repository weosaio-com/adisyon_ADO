import { dirname, join } from 'node:path';

/**
 * Yerel veri dizini: ADO_DATA_DIR (paketli surumde Electron userData) ya da
 * SQLite dosyasinin klasoru. Yedekler, TLS sertifikalari ve restore isareti burada.
 */
export function resolveDataDir(): string {
  const explicit = process.env.ADO_DATA_DIR?.trim();
  if (explicit) return explicit;
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (databaseUrl.startsWith('file:')) return dirname(databaseUrl.slice(5));
  return join(process.cwd(), 'prisma');
}

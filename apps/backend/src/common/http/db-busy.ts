import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Veritabani gecici olarak mesgul (ornegin yedek alinirken SQLite kilidi). Istemci oturumu
 * KAPATMAZ, birkac saniye sonra tekrar dener: 401 yalniz gecersiz oturum icindir.
 */
export const DB_BUSY = 'DB_BUSY';
export const DB_BUSY_MESSAGE = 'Sistem şu an meşgul, birkaç saniye sonra tekrar deneyin.';

// Prisma: P1008 islem zaman asimi, P2024 baglanti havuzu zaman asimi, P2034 yazma cakismasi.
const BUSY_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);
const BUSY_TEXT =
  /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|timed out/i;

/** Hata veritabaninin gecici olarak kullanilamamasindan mi (kalici veri hatasi degil)? */
export function isDatabaseBusyError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return BUSY_CODES.has(err.code) || BUSY_TEXT.test(err.message);
  }
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError
  ) {
    return BUSY_TEXT.test(err.message);
  }
  return (
    err instanceof Error && BUSY_TEXT.test(err.message) && /sqlite|database/i.test(err.message)
  );
}

export class DatabaseBusyException extends ServiceUnavailableException {
  constructor() {
    super({ code: DB_BUSY, message: DB_BUSY_MESSAGE });
  }
}

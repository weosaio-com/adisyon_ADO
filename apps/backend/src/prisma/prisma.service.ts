import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * SQLite ayni anda tek yazara izin verir. Prisma'nin varsayilan coklu baglanti havuzunda ayni
 * anda yazan cihazlar dosya kilidinde (busy_timeout 5 sn) birbirini bekleyip dusuyordu: 6 tablet
 * ayni anda kalem ekleyince isteklerin %78'i 5 sn takilip hata verdi (SAT-5). Tek baglantida
 * istekler Prisma'nin kendi kuyrugunda sirayla ve beklemeden calisir (12 eszamanli yazarda hata
 * yok). Tek kaynak burasi: gelistirme, CI ve paketli surum (masaustu DATABASE_URL'i duz dosya
 * yolu verir; data-dir gibi yerler onu yol olarak okur) ayni havuzu kullanir. URL'de
 * `connection_limit` zaten varsa (bilerek verilmis deneme degeri) ona dokunulmaz.
 */
export function singleConnectionUrl(url: string): string {
  const query = url.indexOf('?');
  const params = query === -1 ? '' : url.slice(query + 1);
  if (params.split('&').some((pair) => pair.split('=')[0] === 'connection_limit')) return url;
  if (query === -1) return `${url}?connection_limit=1`;
  return `${url}${params ? '&' : ''}connection_limit=1`;
}

/**
 * Etkilesimli islem (`$transaction(async (tx) => ...)`) varsayilanlari. Tek baglantida islem
 * baglantiyi kuyrukta bekler:
 * - maxWait 5 sn (Prisma varsayilani 2 sn): 12 tabletlik ani yogunluk kuyrugu 0,5 sn'nin altinda
 *   eritir, ama baska bir surecin tuttugu kisa kilit (ornegin 2,5 sn) 2 sn'de "Unable to start a
 *   transaction in the given time" ile gereksiz hata uretiyordu (yuk testi:
 *   test/load.spawn.e2e.mjs). 5 sn, istemcinin 30 sn istek suresinin cok altinda kalir.
 * - timeout 10 sn (varsayilan 5 sn): islem icindeki bir sorgu SQLite kilidinde busy_timeout
 *   (5 sn) kadar bekleyebilir; islem suresi bundan uzun olmali ki hata "Transaction already
 *   closed" yerine anlasilir kilit hatasi (503 DB_BUSY) olsun. Islemler kisa (tamami tx ile
 *   calisir, icinde ag/yazici beklemesi yok); bu sure yalniz takilma durumunun ust siniridir.
 */
export const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

/** Prisma baglantisini Nest yasam dongusune baglar (connect/disconnect). */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = process.env.DATABASE_URL;
    super({
      ...(url ? { datasourceUrl: singleConnectionUrl(url) } : {}),
      transactionOptions: TRANSACTION_OPTIONS,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma baglandi (SQLite, tek baglanti).');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

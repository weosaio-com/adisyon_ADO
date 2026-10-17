import { Global, Module } from '@nestjs/common';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';

/**
 * Global: siparis modulu yeni adisyon acarken lisans kilidini sorar (assertCanOpenOrder);
 * bulut baglantisi lisansi okur. Bagimliliklari (Prisma, audit, event, config, bayraklar) @Global.
 */
@Global()
@Module({
  controllers: [LicenseController],
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicenseModule {}

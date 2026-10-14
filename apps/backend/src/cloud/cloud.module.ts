import { Module } from '@nestjs/common';
import { LicenseModule } from '../license/license.module';
import { CloudController } from './cloud.controller';
import { CloudService } from './cloud.service';

/**
 * QR menu bulutu: lisansla acma + otomatik yayin. Worker, config ve audit @Global.
 * CloudService disari acilir: bulut yedegi baglantiyi `currentLink` ile okur.
 */
@Module({
  imports: [LicenseModule],
  controllers: [CloudController],
  providers: [CloudService],
  exports: [CloudService],
})
export class CloudModule {}

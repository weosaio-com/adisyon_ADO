import { Module } from '@nestjs/common';
import { LicenseModule } from '../license/license.module';
import { CloudController } from './cloud.controller';
import { CloudService } from './cloud.service';

/** QR menu bulutu: lisansla acma + otomatik yayin. Worker, config ve audit @Global. */
@Module({
  imports: [LicenseModule],
  controllers: [CloudController],
  providers: [CloudService],
})
export class CloudModule {}

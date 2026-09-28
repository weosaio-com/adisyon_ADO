import { Module } from '@nestjs/common';
import { CloudController } from './cloud.controller';
import { CloudService } from './cloud.service';

/** QR menu bulutu: eslestirme + otomatik yayin. Worker, feature flag ve audit @Global. */
@Module({
  controllers: [CloudController],
  providers: [CloudService],
})
export class CloudModule {}

import { Module } from '@nestjs/common';
import { BackupModule } from '../backup/backup.module';
import { UpdatesController } from './updates.controller';
import { UpdatesService } from './updates.service';

/** Otomatik guncelleme onayi. Masaustu koprusu, config ve audit @Global. */
@Module({
  imports: [BackupModule],
  controllers: [UpdatesController],
  providers: [UpdatesService],
})
export class UpdatesModule {}

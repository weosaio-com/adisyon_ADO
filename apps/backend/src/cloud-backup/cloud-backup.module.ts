import { Module } from '@nestjs/common';
import { BackupModule } from '../backup/backup.module';
import { CloudModule } from '../cloud/cloud.module';
import { CloudBackupController } from './cloud-backup.controller';
import { CloudBackupService } from './cloud-backup.service';
import { CloudRestoreService } from './cloud-restore.service';

/**
 * Otomatik bulut yedegi (Faz A / A3): yerel yedeklerin sifreli halini buluta yukler, yeni
 * bilgisayarda buluttan geri yuklemeyi saglar (/cloud-backups). Baglantiyi CloudService'ten
 * (`currentLink`), yedekleri BackupService'ten alir. Tasarim: CLOUD_BACKUP.md.
 */
@Module({
  imports: [CloudModule, BackupModule],
  controllers: [CloudBackupController],
  providers: [CloudBackupService, CloudRestoreService],
})
export class CloudBackupModule {}

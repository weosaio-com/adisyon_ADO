import { Module } from '@nestjs/common';
import { BackupModule } from '../backup/backup.module';
import { MaintenanceService } from './maintenance.service';
import { StorageController } from './storage.controller';

/**
 * Depolama ve temizlik (Faz A / A1): akilli yedek saklama (BackupService.applyRetention),
 * teknik kayitlarin ve artik dosyalarin gunluk temizligi (05:30, kendi zamanlayicisi), disk ve
 * veritabani boyutu (/storage) ve heartbeat saglik bilgisi ('storage'). Ayrinti: STORAGE.md.
 */
@Module({
  imports: [BackupModule],
  providers: [MaintenanceService],
  controllers: [StorageController],
})
export class MaintenanceModule {}

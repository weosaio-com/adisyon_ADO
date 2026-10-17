import { Controller, Get, Post } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { MaintenanceService } from './maintenance.service';

/**
 * Depolama: disk ve veri boyutlari (bilgi amacli; /health disk dolulugunu artik denetlemez) ve
 * elle temizlik. Lisans kilitliyken de acik (license.paths.ts): disk dolarsa temizlik yapilabilmeli.
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get()
  @RequirePermissions(Permission.BackupManage)
  info(@CurrentUser() user: AuthUser) {
    return this.maintenance.storageInfo(user.branchId);
  }

  // Akilli yedek saklama + teknik kayit/dosya temizligi hemen; ozet doner.
  @Post('cleanup')
  @RequirePermissions(Permission.BackupManage)
  cleanup(@CurrentUser() user: AuthUser) {
    return this.maintenance.cleanupNow(user);
  }
}

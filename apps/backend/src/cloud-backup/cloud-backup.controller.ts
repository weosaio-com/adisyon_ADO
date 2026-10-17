import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { CloudBackupService } from './cloud-backup.service';
import { CloudRestoreService } from './cloud-restore.service';
import {
  cloudBackupSwitchSchema,
  cloudSetupListSchema,
  cloudSetupRestoreSchema,
  type CloudBackupSwitchDto,
  type CloudSetupListDto,
  type CloudSetupRestoreDto,
} from './dto/cloud-backup.schemas';

/**
 * Bulut yedegi (Ayarlar > Bulut yedegi) ve yeni bilgisayarda buluttan geri yukleme. Lisans
 * suresi dolsa da acik (license.paths: veri rehin tutulmaz).
 */
@Controller('cloud-backups')
export class CloudBackupController {
  constructor(
    private readonly uploads: CloudBackupService,
    private readonly restores: CloudRestoreService,
  ) {}

  @Get('status')
  @RequirePermissions(Permission.BackupManage)
  status(@CurrentUser() user: AuthUser) {
    return this.uploads.status(user.branchId);
  }

  @Post('upload-now')
  @RequirePermissions(Permission.BackupManage)
  uploadNow(@CurrentUser() user: AuthUser) {
    return this.uploads.uploadNow(user);
  }

  @Put('settings')
  @RequirePermissions(Permission.BackupManage)
  settings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(cloudBackupSwitchSchema)) dto: CloudBackupSwitchDto,
  ) {
    return this.uploads.setSwitch(user, dto.enabled);
  }

  // --- Yeni bilgisayar: ilk kurulum ekranindan buluttan geri yukleme ---------
  // Yalniz ana bilgisayardan ve henuz kullanici yokken (backups/setup/* ile ayni kural).

  @Public()
  @Post('setup/list')
  setupList(
    @Req() req: Request,
    @Body(new ZodValidationPipe(cloudSetupListSchema)) dto: CloudSetupListDto,
  ) {
    return this.restores.list(req.ip, dto.licenseKey);
  }

  @Public()
  @Post('setup/restore')
  setupRestore(
    @Req() req: Request,
    @Body(new ZodValidationPipe(cloudSetupRestoreSchema)) dto: CloudSetupRestoreDto,
  ) {
    return this.restores.restore(req.ip, dto);
  }
}

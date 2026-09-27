import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { AuthService } from '../auth/auth.service';
import { BackupService } from './backup.service';
import {
  recoveryKeySchema,
  restoreBackupSchema,
  type RecoveryKeyDto,
  type RestoreBackupDto,
} from './dto/backup.schemas';

@Controller('backups')
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @RequirePermissions(Permission.BackupManage)
  create(@CurrentUser() user: AuthUser) {
    return this.backupService.createBackup(user, 'manual');
  }

  @Get()
  @RequirePermissions(Permission.BackupManage)
  list(@CurrentUser() user: AuthUser) {
    return this.backupService.listBackups(user);
  }

  // Disaridan sifreli yedek dosyasi (govde: application/octet-stream).
  @Post('import')
  @RequirePermissions(Permission.BackupManage)
  import(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.backupService.importBackup(user, req);
  }

  // Kurtarma anahtari: yonetici sifresi ister; duz metin yalniz bu yanitta doner.
  @Post('recovery-key')
  @RequirePermissions(Permission.BackupManage)
  async recoveryKey(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(recoveryKeySchema)) dto: RecoveryKeyDto,
  ) {
    const { ok } = await this.auth.verifyOwner(user.branchId, dto.password);
    if (!ok) {
      throw new ForbiddenException({
        code: 'OWNER_PASSWORD_INVALID',
        message: 'Yönetici şifresi hatalı.',
      });
    }
    return this.backupService.revealRecoveryKey(user);
  }

  @Post(':id/restore')
  @RequirePermissions(Permission.BackupManage)
  restore(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(restoreBackupSchema)) dto: RestoreBackupDto,
  ) {
    return this.backupService.restoreBackup(user, id, dto.recoveryKey);
  }

  @Delete(':id')
  @RequirePermissions(Permission.BackupManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.backupService.deleteBackup(user, id);
  }

  // --- Yeni bilgisayar: ilk kurulum ekranindan yedekten geri yukleme ---------
  // Yalniz ana bilgisayardan ve henuz kullanici yokken (auth/setup ile ayni kural).

  @Public()
  @Post('setup/import')
  async setupImport(@Req() req: Request) {
    const branchId = await this.backupService.setupBranchOrThrow(req.ip);
    return this.backupService.importBackup({ branchId }, req);
  }

  @Public()
  @Post('setup/:id/restore')
  async setupRestore(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(restoreBackupSchema)) dto: RestoreBackupDto,
  ) {
    const branchId = await this.backupService.setupBranchOrThrow(req.ip);
    return this.backupService.restoreBackup({ branchId }, id, dto.recoveryKey);
  }
}

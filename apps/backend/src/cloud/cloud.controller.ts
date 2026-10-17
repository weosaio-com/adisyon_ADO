import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { CloudService } from './cloud.service';
import {
  cloudActivateSchema,
  cloudQrSchema,
  type CloudActivateDto,
  type CloudQrDto,
} from './dto/cloud.schemas';

/**
 * Bulut baglantisi (Ayarlar > Lisans satiri) ve QR menu (Ayarlar > QR Menu): durum, simdi baglan
 * (devral), QR menu ac/kapat, simdi yayinla. Yalniz yonetici. Baglanti lisansla kendiliginden kurulur.
 */
@Controller('cloud')
export class CloudController {
  constructor(private readonly cloud: CloudService) {}

  @Get('status')
  @RequirePermissions(Permission.SettingsManage)
  status(@CurrentUser() user: AuthUser) {
    return this.cloud.status(user);
  }

  // Simdi baglan (bagliysa durumu hemen yeniler). `takeover`: baska bilgisayardaki baglantiyi al.
  // Internet yoksa istek saklanir ve yeniden denenir.
  @Post('activate')
  @RequirePermissions(Permission.SettingsManage)
  activate(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(cloudActivateSchema)) dto: CloudActivateDto,
  ) {
    return this.cloud.activate(user, dto);
  }

  // QR menu ac (gerekirse baglanir, yayinlar) / kapat (menu ve masalar buluttan kalkar).
  @Put('qr')
  @RequirePermissions(Permission.SettingsManage)
  setQr(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(cloudQrSchema)) dto: CloudQrDto,
  ) {
    return this.cloud.setQr(user, dto.enabled);
  }

  @Post('publish')
  @RequirePermissions(Permission.SettingsManage)
  publish(@CurrentUser() user: AuthUser) {
    return this.cloud.publishNow(user);
  }

  // Eski uc (0.3.0 "QR menuyu kapat"): artik yalniz QR menuyu kapatir; baglanti kalir.
  @Delete('connection')
  @RequirePermissions(Permission.SettingsManage)
  disconnect(@CurrentUser() user: AuthUser) {
    return this.cloud.setQr(user, false);
  }
}

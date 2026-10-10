import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { CloudService } from './cloud.service';
import { cloudActivateSchema, type CloudActivateDto } from './dto/cloud.schemas';

/** QR menu bulut baglantisi (Ayarlar > QR Menu): ac, kapat, simdi yayinla. Yalniz yonetici. */
@Controller('cloud')
export class CloudController {
  constructor(private readonly cloud: CloudService) {}

  @Get('status')
  @RequirePermissions(Permission.SettingsManage)
  status(@CurrentUser() user: AuthUser) {
    return this.cloud.status(user);
  }

  // Lisansla ac; ilk yayin hemen baslar. Internet yoksa istek saklanir ve yeniden denenir.
  @Post('activate')
  @RequirePermissions(Permission.SettingsManage)
  activate(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(cloudActivateSchema)) dto: CloudActivateDto,
  ) {
    return this.cloud.activate(user, dto);
  }

  @Post('publish')
  @RequirePermissions(Permission.SettingsManage)
  publish(@CurrentUser() user: AuthUser) {
    return this.cloud.publishNow(user);
  }

  @Delete('connection')
  @RequirePermissions(Permission.SettingsManage)
  disconnect(@CurrentUser() user: AuthUser) {
    return this.cloud.disconnect(user);
  }
}

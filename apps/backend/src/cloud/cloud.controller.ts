import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { CloudService } from './cloud.service';
import { cloudPairSchema, type CloudPairDto } from './dto/cloud.schemas';

/** QR menu bulut baglantisi (Ayarlar > QR Menu). Yalniz yonetici. */
@Controller('cloud')
export class CloudController {
  constructor(private readonly cloud: CloudService) {}

  @Get('status')
  @RequirePermissions(Permission.SettingsManage)
  status(@CurrentUser() user: AuthUser) {
    return this.cloud.status(user);
  }

  // Panelden alinan eslestirme koduyla baglan; ilk yayin hemen baslar.
  @Post('pair')
  @RequirePermissions(Permission.SettingsManage)
  pair(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(cloudPairSchema)) dto: CloudPairDto,
  ) {
    return this.cloud.pair(user, dto);
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

import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { Permission } from '@ado/shared';
import { businessInfoSchema, SettingsService, type BusinessInfoDto } from './settings.service';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';

const setSettingSchema = z.object({ value: z.unknown() });
type SetSettingDto = z.infer<typeof setSettingSchema>;

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions(Permission.SettingsManage)
  list(@CurrentUser() user: AuthUser) {
    return this.settings.list(user);
  }

  // Isletme bilgileri (fis basligi). ':key' rotasindan once tanimli olmali.
  @Get('business')
  @RequirePermissions(Permission.SettingsManage)
  getBusiness(@CurrentUser() user: AuthUser) {
    return this.settings.getBusiness(user);
  }

  @Put('business')
  @RequirePermissions(Permission.SettingsManage)
  setBusiness(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(businessInfoSchema)) dto: BusinessInfoDto,
  ) {
    return this.settings.setBusiness(user, dto);
  }

  @Put(':key')
  @RequirePermissions(Permission.SettingsManage)
  set(
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(setSettingSchema)) dto: SetSettingDto,
  ) {
    return this.settings.set(user, key, dto.value);
  }
}

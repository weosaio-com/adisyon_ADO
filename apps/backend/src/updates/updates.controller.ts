import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { UpdatesService } from './updates.service';
import { updateApproveSchema, type UpdateApproveDto } from './dto/updates.schemas';

/** Ayarlar > Guncelleme: durum, simdi denetle, kurulum onayi (yalniz kasa bilgisayarindan). */
@Controller('updates')
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}

  @Get('status')
  @RequirePermissions(Permission.UpdateManage)
  status(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.updates.status(user, req.ip);
  }

  @Post('check')
  @RequirePermissions(Permission.UpdateManage)
  check(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.updates.check(user, req.ip);
  }

  @Post('approve')
  @RequirePermissions(Permission.UpdateManage)
  approve(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body(new ZodValidationPipe(updateApproveSchema)) dto: UpdateApproveDto,
  ) {
    return this.updates.approve(user, req.ip, dto.version);
  }
}

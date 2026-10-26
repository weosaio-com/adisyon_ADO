import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { SyncService } from './sync.service';
import {
  pushMutationsSchema,
  resolveGroupSchema,
  resolveReviewSchema,
  reviewStatusSchema,
} from './dto/sync.schemas';
import type {
  PushMutationsDto,
  ResolveGroupDto,
  ResolveReviewDto,
  ReviewStatusDto,
} from './dto/sync.schemas';

/** Istemci-offline senkron uclari. OFFLINE_DESIGN.md §7 */
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  // Hafif baglanabilirlik yoklamasi: navigator.onLine guvenilmez (§7.3).
  // Token'siz: tablet, token yenilemeden ONCE gercek erisilebilirligi olcer.
  @Get('health')
  @Public()
  health() {
    return { ok: true, serverTime: new Date().toISOString() };
  }

  @Post('mutations')
  @RequirePermissions(Permission.OrderCreate)
  push(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(pushMutationsSchema)) dto: PushMutationsDto,
  ) {
    return this.sync.pushMutations(user, dto);
  }

  @Get('snapshot')
  @RequirePermissions(Permission.TableView)
  snapshot(@CurrentUser() user: AuthUser) {
    return this.sync.snapshot(user);
  }

  // Tablet, onaya dusen kayitlarinin sonucunu sorar (taslagi temizler ya da adisyona baglar).
  @Post('reviews/status')
  @RequirePermissions(Permission.OrderCreate)
  reviewStatus(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(reviewStatusSchema)) dto: ReviewStatusDto,
  ) {
    return this.sync.reviewStatus(user, dto.clientOpIds);
  }
}

/** Cakisan offline mutasyonlarin Owner onay kuyrugu. API_DESIGN.md §5.11 */
@Controller('offline-reviews')
export class OfflineReviewsController {
  constructor(private readonly sync: SyncService) {}

  @Get()
  @RequirePermissions(Permission.OrderCancel)
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.sync.listReviews(user, status);
  }

  // Siparis duzeyinde tek karar (OFF-2): OPEN_TABLE + kalemler + mutfaga gonder birlikte.
  @Post('resolve-group')
  @RequirePermissions(Permission.OrderCancel)
  resolveGroup(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(resolveGroupSchema)) dto: ResolveGroupDto,
  ) {
    return this.sync.resolveGroup(user, dto);
  }

  @Post(':id/resolve')
  @RequirePermissions(Permission.OrderCancel)
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resolveReviewSchema)) dto: ResolveReviewDto,
  ) {
    return this.sync.resolveReview(user, id, dto);
  }
}

import { Body, Controller, ForbiddenException, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Permission } from '@ado/shared';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { isLocalRequest } from '../common/http/local-request';
import {
  loginSchema,
  loginPinSchema,
  refreshSchema,
  setupSchema,
  verifyOwnerSchema,
  recoveryResetSchema,
  recoveryToggleSchema,
  type LoginDto,
  type LoginPinDto,
  type RefreshDto,
  type SetupDto,
  type VerifyOwnerDto,
  type RecoveryResetDto,
  type RecoveryToggleDto,
} from './dto/auth.schemas';
import { AuthService, type RequestMeta } from './auth.service';
import { RecoveryService } from './recovery.service';

function metaOf(req: Request): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ...(req.ip ? { ip: req.ip } : {}),
    ...(typeof ua === 'string' ? { userAgent: ua } : {}),
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: RecoveryService,
  ) {}

  @Public()
  @Get('setup-status')
  setupStatus(): Promise<unknown> {
    return this.auth.setupStatus();
  }

  @Public()
  @Post('setup')
  setup(
    @Body(new ZodValidationPipe(setupSchema)) dto: SetupDto,
    @Req() req: Request,
  ): Promise<unknown> {
    if (!isLocalRequest(req.ip)) {
      throw new ForbiddenException({
        code: 'SETUP_LOCAL_ONLY',
        message: 'Ilk kurulum yalnizca ana bilgisayardan yapilabilir.',
      });
    }
    return this.auth.setup(dto);
  }

  @Public()
  @Post('login')
  login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.auth.login(dto, metaOf(req));
  }

  @Public()
  @Post('login-pin')
  loginPin(
    @Body(new ZodValidationPipe(loginPinSchema)) dto: LoginPinDto,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.auth.loginPin(dto, metaOf(req));
  }

  @Public()
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto): Promise<unknown> {
    return this.auth.refresh(dto);
  }

  @Post('logout')
  logout(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.auth.logout(user);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<unknown> {
    return this.auth.me(user);
  }

  // Owner sifre onayi (gun sonu vb.). Giris yapmis herhangi bir kullanici cagirir.
  @Post('verify-owner')
  verifyOwner(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(verifyOwnerSchema)) dto: VerifyOwnerDto,
  ): Promise<{ ok: boolean }> {
    return this.auth.verifyOwner(user.branchId, dto.password);
  }

  // --- Sifre kurtarma (kurtarma kodu) ---------------------------------------
  // Varsayilan KAPALI: `auth.recovery.enabled` acilmadikca sifirlama reddedilir
  // ve giris ekraninda baglanti gorunmez.

  /** Giris ekrani "Sifremi unuttum" baglantisini gostersin mi. */
  @Public()
  @Get('recovery/status')
  recoveryPublicStatus(): Promise<{ enabled: boolean }> {
    return this.recovery.publicStatus();
  }

  /** Sahibi icin: acik mi, uretilmis kod var mi. */
  @Get('recovery')
  @RequirePermissions(Permission.UserManage)
  recoveryStatus(@CurrentUser() user: AuthUser): Promise<{ enabled: boolean; hasCode: boolean }> {
    return this.recovery.status(user);
  }

  /** Yeni kod uretir; duz metin YALNIZCA bu yanitta doner. */
  @Post('recovery/generate')
  @RequirePermissions(Permission.UserManage)
  recoveryGenerate(@CurrentUser() user: AuthUser): Promise<{ code: string }> {
    return this.recovery.generate(user);
  }

  @Post('recovery/enabled')
  @RequirePermissions(Permission.UserManage)
  recoveryToggle(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(recoveryToggleSchema)) dto: RecoveryToggleDto,
  ): Promise<{ enabled: boolean }> {
    return this.recovery.setEnabled(user, dto.enabled);
  }

  @Public()
  @Post('recovery/reset')
  recoveryReset(
    @Body(new ZodValidationPipe(recoveryResetSchema)) dto: RecoveryResetDto,
  ): Promise<{ ok: true }> {
    return this.recovery.resetPassword(dto.username, dto.code, dto.newPassword);
  }
}

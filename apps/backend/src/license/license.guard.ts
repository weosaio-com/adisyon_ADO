import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { LicenseService } from './license.service';
import { isAlwaysAllowed } from './license.paths';

// Lisans suresi dolduysa yazma islemlerini durdurur.
//
// KAPALI GELIR: `license.enforce` ayari true degilse guard hicbir sey yapmaz.
// Bu yuzden simdilik hicbir kurulumu etkilemez; acmak icin tek ayar yeter.
//
// Suresi dolsa bile ASLA engellenmeyenler: okuma (GET) ve isAlwaysAllowed
// uclari (giris, lisans, yedek, saglik). Yani "veri rehin alinmaz", yalnizca
// yeni satis girisi durur.

@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(private readonly license: LicenseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    if (isAlwaysAllowed(req.path ?? req.url ?? '')) return true;

    // Kullanici yoksa (public uc) lisans denetimi yapilmaz; JwtAuthGuard zaten
    // karar vermistir.
    const branchId = req.user?.branchId;
    if (!branchId) return true;

    const status = await this.license.getStatus(branchId);
    if (!status.enforced) return true;
    if (status.state === 'active' || status.state === 'grace') return true;

    throw new ForbiddenException({
      code: 'LICENSE_EXPIRED',
      message:
        status.state === 'none'
          ? 'Lisans tanımlı değil. Ayarlar > Lisans bölümünden anahtarınızı girin.'
          : 'Lisans süresi doldu. Ayarlar > Lisans bölümünden yenileyin.',
    });
  }
}

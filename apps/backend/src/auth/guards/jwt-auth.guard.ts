import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { DatabaseBusyException } from '../../common/http/db-busy';
import { TokenService } from '../token.service';
import { PrismaService } from '../../prisma/prisma.service';

const invalidToken = () =>
  new UnauthorizedException({
    code: 'INVALID_TOKEN',
    message: 'Gecersiz veya suresi dolmus oturum.',
  });

/**
 * Bearer access token dogrular; req.user'i doldurur. @Public() ile atlanir.
 * Yalniz gecersiz/suresi dolmus token ve kapanmis oturum 401 verir. Oturum kaydi okunamazsa
 * (veritabani mesgul: yedek, agir rapor) 503 DB_BUSY: istemci oturumu kapatmadan tekrar dener.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      throw new UnauthorizedException({
        code: 'NO_TOKEN',
        message: 'Kimlik dogrulama gerekli.',
      });
    }

    let payload: Awaited<ReturnType<TokenService['verifyAccess']>>;
    try {
      payload = await this.tokens.verifyAccess(token);
    } catch {
      throw invalidToken();
    }

    let session: { id: string } | null;
    try {
      session = await this.prisma.session.findFirst({
        where: {
          id: payload.sid,
          userId: payload.sub,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: {
            branchId: payload.branchId,
            isActive: true,
            deletedAt: null,
          },
        },
        select: { id: true },
      });
    } catch (err) {
      this.logger.warn(
        `Oturum denetimi yapilamadi (veritabani): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new DatabaseBusyException();
    }
    if (!session) throw invalidToken();

    const user: AuthUser = {
      userId: payload.sub,
      sessionId: payload.sid,
      username: payload.username,
      role: payload.role,
      branchId: payload.branchId,
      permissions: payload.perms ?? [],
      ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
    };
    req.user = user;
    return true;
  }
}

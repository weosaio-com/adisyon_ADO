// Kimlik koruyucusu self-check'i: gecersiz token 401, veritabani mesgulken 503 DB_BUSY (oturum
// kapanmasin), kapanmis oturum 401, gecerli oturum gecer.
// `ts-node --transpile-only src/auth/guards/jwt-auth.guard.selfcheck.ts`
import 'reflect-metadata';
import assert from 'node:assert';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { TokenService } from '../token.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/http/all-exceptions.filter';
import { DB_BUSY, isDatabaseBusyError } from '../../common/http/db-busy';

const PAYLOAD = {
  sub: 'u1',
  sid: 's1',
  username: 'owner',
  role: 'OWNER',
  branchId: 'b1',
  perms: ['orders.manage'],
};

function context(authorization?: string) {
  const req: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function guard(opts: { verify: () => Promise<unknown>; findFirst: () => Promise<unknown> }) {
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  const tokens = { verifyAccess: opts.verify } as unknown as TokenService;
  const prisma = { session: { findFirst: opts.findFirst } } as unknown as PrismaService;
  const g = new JwtAuthGuard(reflector, tokens, prisma);
  // Kayit gurultusu olmasin.
  (g as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
  return g;
}

function codeOf(err: unknown): unknown {
  const resp = (err as { getResponse?: () => unknown }).getResponse?.();
  return resp && typeof resp === 'object' ? (resp as Record<string, unknown>)['code'] : undefined;
}

const busyError = () =>
  new Prisma.PrismaClientKnownRequestError('Operation has timed out', {
    code: 'P1008',
    clientVersion: '6.19.3',
  });

async function main() {
  // Token yok: 401 NO_TOKEN.
  await assert.rejects(
    guard({ verify: async () => PAYLOAD, findFirst: async () => ({ id: 's1' }) }).canActivate(
      context().ctx,
    ),
    (err) => err instanceof UnauthorizedException && codeOf(err) === 'NO_TOKEN',
  );

  // Gecersiz/suresi dolmus token: 401 INVALID_TOKEN; veritabanina hic gidilmez.
  let dbCalls = 0;
  await assert.rejects(
    guard({
      verify: async () => {
        throw new Error('jwt expired');
      },
      findFirst: async () => {
        dbCalls++;
        return { id: 's1' };
      },
    }).canActivate(context('Bearer x').ctx),
    (err) => err instanceof UnauthorizedException && codeOf(err) === 'INVALID_TOKEN',
  );
  assert.strictEqual(dbCalls, 0);

  // Veritabani mesgul (yedek alinirken kilit): 503 DB_BUSY, 401 DEGIL.
  await assert.rejects(
    guard({
      verify: async () => PAYLOAD,
      findFirst: async () => {
        throw busyError();
      },
    }).canActivate(context('Bearer x').ctx),
    (err) => err instanceof ServiceUnavailableException && codeOf(err) === DB_BUSY,
  );
  // Siniflandirilamayan veritabani hatasi da oturumu kapatmaz.
  await assert.rejects(
    guard({
      verify: async () => PAYLOAD,
      findFirst: async () => {
        throw new Error('SQLITE_IOERR');
      },
    }).canActivate(context('Bearer x').ctx),
    (err) => err instanceof ServiceUnavailableException && codeOf(err) === DB_BUSY,
  );

  // Kapanmis/bulunmayan oturum: 401.
  await assert.rejects(
    guard({ verify: async () => PAYLOAD, findFirst: async () => null }).canActivate(
      context('Bearer x').ctx,
    ),
    (err) => err instanceof UnauthorizedException && codeOf(err) === 'INVALID_TOKEN',
  );

  // Gecerli oturum: gecer, req.user dolar.
  const ok = context('Bearer x');
  assert.strictEqual(
    await guard({ verify: async () => PAYLOAD, findFirst: async () => ({ id: 's1' }) }).canActivate(
      ok.ctx,
    ),
    true,
  );
  assert.deepStrictEqual(ok.req.user, {
    userId: 'u1',
    sessionId: 's1',
    username: 'owner',
    role: 'OWNER',
    branchId: 'b1',
    permissions: ['orders.manage'],
  });

  // Siniflandirma: gecici kilit/zaman asimi evet, veri cakismasi ve siradan hata hayir.
  assert.strictEqual(isDatabaseBusyError(busyError()), true);
  assert.strictEqual(isDatabaseBusyError(new Error('SqliteError: database is locked')), true);
  assert.strictEqual(
    isDatabaseBusyError(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
      }),
    ),
    false,
  );
  assert.strictEqual(isDatabaseBusyError(new Error('fetch timed out')), false);

  // Genel hata filtresi: rotadaki kilit hatasi 500 degil 503 DB_BUSY olur.
  let status = 0;
  let body: { error?: { code?: string } } = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: typeof body) {
      body = payload;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'GET', url: '/api/v1/reports', id: 'r1' }),
    }),
  };
  const filter = new AllExceptionsFilter();
  // Kayit gurultusu olmasin.
  (filter as unknown as { logger: { warn: () => void; error: () => void } }).logger = {
    warn: () => undefined,
    error: () => undefined,
  };
  filter.catch(busyError(), host as never);
  assert.strictEqual(status, 503);
  assert.strictEqual(body.error?.code, DB_BUSY);

  console.log('✓ jwt-auth.guard self-check OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

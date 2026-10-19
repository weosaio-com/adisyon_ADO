import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { DB_BUSY, DB_BUSY_MESSAGE, isDatabaseBusyError } from './db-busy';

interface ErrorBody {
  code: string;
  message: string;
  details?: Array<{ field: string; issue: string }>;
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_ERROR';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

/** Tum hatalari ortak hata zarfina cevirir. API_DESIGN.md §2. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    const body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Sunucu hatasi.' };

    if (exception instanceof ZodError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      body.code = 'VALIDATION_ERROR';
      body.message = 'Dogrulama hatasi.';
      body.details = exception.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        issue: i.message,
      }));
    } else if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      (exception.code === 'P2002' || exception.code === 'P2003')
    ) {
      status = HttpStatus.CONFLICT;
      body.code = 'DATA_CONFLICT';
      body.message = 'Kayit baska bir islemle cakisti. Veriyi yenileyip tekrar deneyin.';
    } else if (isDatabaseBusyError(exception)) {
      // Gecici: istemci oturumu kapatmadan tekrar dener (yedek alinirken SQLite kilidi gibi).
      status = HttpStatus.SERVICE_UNAVAILABLE;
      body.code = DB_BUSY;
      body.message = DB_BUSY_MESSAGE;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      body.code = defaultCodeForStatus(status);
      body.message = exception.message;
      if (resp && typeof resp === 'object') {
        const r = resp as Record<string, unknown>;
        if (typeof r['code'] === 'string') body.code = r['code'];
        if (typeof r['message'] === 'string') body.message = r['message'];
      }
    }

    if (body.code === DB_BUSY) {
      // Beklenen gecici durum: kayit dosyasinda izi kalsin ama yigin dokumu gerekmez.
      this.logger.warn(
        `DB_BUSY ${req.method} ${req.url}: ${exception instanceof Error ? exception.message : String(exception)}`,
      );
    } else if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(status).json({
      success: false,
      error: { ...body, requestId: req.id ?? null },
    });
  }
}

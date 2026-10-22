import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { defaultErrorMap, ZodError, type ZodIssue } from 'zod';
import { Prisma } from '@prisma/client';
import { DB_BUSY, DB_BUSY_MESSAGE, isDatabaseBusyError } from './db-busy';

interface ErrorBody {
  code: string;
  message: string;
  details?: Array<{ field: string; issue: string }>;
  /** Hatanin baglami (or. TABLE_HAS_OPEN_ORDER icin `orderId`). API_DESIGN.md §2. */
  data?: Record<string, unknown>;
}

const VALIDATION_MESSAGE = 'Doğrulama hatası.';

/**
 * Dogrulama hatasinin zarf mesaji: ilk sorunun semada verilmis (Turkce) mesaji, boylece sinir
 * hatalari (or. tutar ust siniri) ekranda anlasilir gorunur. Zod'un varsayilan Ingilizce mesajlari
 * ("Required", "Expected number...") kullaniciya gosterilmez, genel metin kalir. Tum sorunlar
 * `details`'te aynen durur.
 */
function validationMessage(issues: ZodIssue[]): string {
  const first = issues[0];
  if (!first?.message) return VALIDATION_MESSAGE;
  const standard = defaultErrorMap(first, { data: undefined, defaultError: '' }).message;
  return first.message === standard ? VALIDATION_MESSAGE : first.message;
}

/**
 * HttpException yanitinda zarfin kendi alanlari; geri kalanlar (or. `orderId`) `data` altinda
 * iletilir (alan adlari zarfla cakismaz). Nest'in `statusCode`/`error` alanlari alinmaz.
 */
const ENVELOPE_KEYS = new Set(['code', 'message', 'details', 'data', 'statusCode', 'error']);

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
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'PAYLOAD_TOO_LARGE';
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'VALIDATION_ERROR';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

const BODY_ERRORS: Record<string, { code: string; message: string }> = {
  'entity.too.large': {
    code: 'PAYLOAD_TOO_LARGE',
    message: 'İstek çok büyük; daha küçük parçalar halinde gönderin.',
  },
  'parameters.too.many': {
    code: 'PAYLOAD_TOO_LARGE',
    message: 'İstek çok büyük; daha küçük parçalar halinde gönderin.',
  },
  'entity.parse.failed': { code: 'BAD_JSON', message: 'İstek gövdesi geçerli JSON değil.' },
  'encoding.unsupported': {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'İstek gövdesinin kodlaması desteklenmiyor.',
  },
  'charset.unsupported': {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'İstek gövdesinin karakter kümesi desteklenmiyor.',
  },
};

/**
 * Govde ayristiricisinin (express.json/urlencoded, http-errors) istemci hatasini kendi kodlu
 * HttpException'a cevirir; degilse null. Eskiden sinir asimi 500 INTERNAL_ERROR'a dusup yigin
 * dokumuyle loglaniyor, bozuk JSON ayristiricinin Ingilizce mesajiyla donuyordu (GUV-3). main.ts
 * bunu ayristiricilarin hemen ardinda da cagirir: Nest, SyntaxError'u filtreden once kendi
 * BadRequestException'ina cevirip hata turunu kaybediyor.
 */
export function bodyParserException(exception: unknown): HttpException | null {
  if (!(exception instanceof Error) || exception instanceof HttpException) return null;
  const { status, type, expose } = exception as Error & {
    status?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  if (typeof type !== 'string' || expose !== true) return null;
  const known = BODY_ERRORS[type];
  return new HttpException(
    {
      code: known?.code ?? defaultCodeForStatus(status),
      message: known?.message ?? 'İstek gövdesi okunamadı.',
    },
    status,
  );
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

    exception = bodyParserException(exception) ?? exception;
    if (exception instanceof ZodError) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      body.code = 'VALIDATION_ERROR';
      body.message = validationMessage(exception.issues);
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
        if (Array.isArray(r['details'])) {
          body.details = r['details'] as NonNullable<ErrorBody['details']>;
        }
        const extra = Object.entries(r).filter(([key]) => !ENVELOPE_KEYS.has(key));
        const data =
          r['data'] && typeof r['data'] === 'object' ? (r['data'] as Record<string, unknown>) : {};
        if (extra.length || Object.keys(data).length) {
          body.data = { ...data, ...Object.fromEntries(extra) };
        }
      }
    }

    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      // Takilan tablet kuyrugunun izi kalsin (GUV-2); tek satir, yigin yok: kimliksiz uca buyuk
      // govdeyle kayit dosyasi sisirilemez.
      const length = req.headers?.['content-length'];
      this.logger.warn(
        `${status} ${body.code} ${req.method} ${req.url}${length ? ` (${length} bayt)` : ''}`,
      );
    } else if (body.code === DB_BUSY) {
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

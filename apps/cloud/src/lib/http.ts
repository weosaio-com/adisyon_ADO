import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Yanit zarfi POS API'siyle aynidir (API_DESIGN.md §2):
 * basari `{ success: true, data }`, hata `{ success: false, error: { code, message, details? } }`.
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: unknown;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200): Response {
  return c.json({ success: true, data }, status);
}

export function errorBody(code: string, message: string, details?: unknown) {
  return {
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

/** JSON govdeyi semaya gore dogrular; gecersizse 422 ve alan bazli ayrintilar. */
export async function readJson<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'İstek gövdesi geçerli JSON değil.');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(
      422,
      'VALIDATION_ERROR',
      'Doğrulama hatası.',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        issue: issue.message,
      })),
    );
  }
  return result.data;
}

export const nowIso = (): string => new Date().toISOString();

// Govde ayristirici hatalari (GUV-3/GUV-2): `ts-node --transpile-only src/common/http/all-exceptions.filter.selfcheck.ts`
// Gercek express.json hatalari uretilir ve genel filtreden gecirilir.
import 'reflect-metadata';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import * as express from 'express';
import { ConflictException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { z } from 'zod';
import { AllExceptionsFilter } from './all-exceptions.filter';

/** express.json'u sahte bir istek akisiyla calistirir; ayristiricinin verdigi hatayi dondurur. */
function parse(body: string, { limit = '1kb', type = 'application/json' } = {}) {
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    headers: { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) },
    method: 'POST',
    url: '/api/v1/auth/login',
  });
  return new Promise<unknown>((resolve) =>
    express.json({ limit })(req as never, {} as never, (err?: unknown) => resolve(err)),
  );
}

function run(exception: unknown) {
  let status = 0;
  let body: {
    error?: {
      code?: string;
      message?: string;
      details?: Array<{ field: string; issue: string }>;
      data?: Record<string, unknown>;
    };
  } = {};
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
      getRequest: () => ({
        method: 'POST',
        url: '/api/v1/auth/login',
        id: 'r1',
        headers: { 'content-length': '153600' },
      }),
    }),
  };
  const filter = new AllExceptionsFilter();
  const logged: string[] = [];
  (filter as unknown as { logger: Record<string, (m: string) => void> }).logger = {
    warn: (m) => logged.push(`warn ${m}`),
    error: (m) => logged.push(`error ${m}`),
  };
  filter.catch(exception, host as never);
  return {
    status,
    code: body.error?.code,
    message: body.error?.message,
    error: body.error,
    logged,
  };
}

async function main() {
  // Sinir asimi: 500 degil 413 PAYLOAD_TOO_LARGE; yigin dokumu yok, tek uyari satiri.
  const tooLarge = await parse(JSON.stringify({ password: 'x'.repeat(2048) }));
  assert.ok(tooLarge, 'ayristirici hata vermeli (deney gecerli)');
  const large = run(tooLarge);
  assert.strictEqual(large.status, 413);
  assert.strictEqual(large.code, 'PAYLOAD_TOO_LARGE');
  assert.match(large.message ?? '', /daha küçük parçalar/);
  assert.deepStrictEqual(large.logged, [
    'warn 413 PAYLOAD_TOO_LARGE POST /api/v1/auth/login (153600 bayt)',
  ]);

  // Bozuk JSON: 400 BAD_JSON, ayristiricinin Ingilizce mesaji disari sizmaz.
  const broken = run(await parse('{"username":'));
  assert.strictEqual(broken.status, 400);
  assert.strictEqual(broken.code, 'BAD_JSON');
  assert.strictEqual(broken.message, 'İstek gövdesi geçerli JSON değil.');
  assert.ok(broken.logged.every((line) => line.startsWith('warn ')));

  // Desteklenmeyen karakter kumesi: 415.
  const charset = run(
    await parse('{}', { type: 'application/json; charset=latin1' }).then((err) => err),
  );
  assert.strictEqual(charset.status, 415);
  assert.strictEqual(charset.code, 'UNSUPPORTED_MEDIA_TYPE');

  // Nest'in kendi 413'u da dogru kodu alir (or. gorsel yukleme siniri).
  const nest = run(new PayloadTooLargeException());
  assert.strictEqual(nest.status, 413);
  assert.strictEqual(nest.code, 'PAYLOAD_TOO_LARGE');

  // Durum alani olan siradan hata istemci hatasi sanilmaz: 500, yigin loglanir.
  const plain = run(Object.assign(new Error('beklenmedik'), { status: 400 }));
  assert.strictEqual(plain.status, 500);
  assert.strictEqual(plain.code, 'INTERNAL_ERROR');
  assert.ok(plain.logged.some((line) => line.startsWith('error ')));

  // Dogrulama: semada verilmis Turkce mesaj zarfa cikar (F2: tutar siniri gibi); ayrintilar aynen.
  const limit = z.object({ amount: z.number().max(100_000, 'Tutar üst sınırı aşıldı.') });
  const limited = run(limit.safeParse({ amount: 500_000 }).error);
  assert.strictEqual(limited.status, 422);
  assert.strictEqual(limited.code, 'VALIDATION_ERROR');
  assert.strictEqual(limited.message, 'Tutar üst sınırı aşıldı.');
  assert.deepStrictEqual(limited.error?.details, [
    { field: 'amount', issue: 'Tutar üst sınırı aşıldı.' },
  ]);
  const custom = z.object({
    pin: z.string().refine((v) => v.length === 4, 'PIN 4 haneli olmalı.'),
  });
  assert.strictEqual(run(custom.safeParse({ pin: '1' }).error).message, 'PIN 4 haneli olmalı.');
  // Zod'un varsayilan Ingilizce mesaji kullaniciya cikmaz: genel Turkce metin, ayrinti yine var.
  const plainZod = run(z.object({ name: z.string() }).safeParse({}).error);
  assert.strictEqual(plainZod.message, 'Doğrulama hatası.');
  assert.deepStrictEqual(plainZod.error?.details, [{ field: 'name', issue: 'Required' }]);
  const tooBig = run(z.object({ n: z.number().max(5) }).safeParse({ n: 9 }).error);
  assert.strictEqual(tooBig.message, 'Doğrulama hatası.');

  // HttpException'daki ek alanlar zarfta `data` altinda (F2: TABLE_HAS_OPEN_ORDER -> orderId).
  const conflict = run(
    new ConflictException({
      code: 'TABLE_HAS_OPEN_ORDER',
      message: 'Masada başka bir aktif adisyon var.',
      orderId: '01ORDER',
    }),
  );
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.code, 'TABLE_HAS_OPEN_ORDER');
  assert.strictEqual(conflict.message, 'Masada başka bir aktif adisyon var.');
  assert.deepStrictEqual(conflict.error?.data, { orderId: '01ORDER' });
  // Zaten `data` ile gelen baglam ve `details` dizisi korunur.
  const nested = run(
    new ConflictException({
      code: 'X',
      message: 'm',
      data: { orderId: '01A' },
      details: [{ field: 'amount', issue: 'too_large' }],
    }),
  );
  assert.deepStrictEqual(nested.error?.data, { orderId: '01A' });
  assert.deepStrictEqual(nested.error?.details, [{ field: 'amount', issue: 'too_large' }]);
  // Nest'in kendi alanlari (statusCode, error) zarfa sizmaz; ek alan yoksa `data` yok.
  const notFound = run(new NotFoundException('Adisyon bulunamadı.'));
  assert.strictEqual(notFound.code, 'NOT_FOUND');
  assert.strictEqual(notFound.message, 'Adisyon bulunamadı.');
  assert.strictEqual(notFound.error?.data, undefined);
  assert.strictEqual(
    run(new ConflictException({ code: 'C', message: 'm' })).error?.data,
    undefined,
  );

  console.log('✓ all-exceptions.filter self-check');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Istek kaydi seviyeleri (PLT-14): `ts-node --transpile-only src/common/http/request-log.selfcheck.ts`
import assert from 'node:assert';
import type { ServerResponse } from 'node:http';
import { startTime } from 'pino-http';
import { pinoRequestLevel, requestLogLevel, SLOW_REQUEST_MS } from './request-log';

// Paketli surum: basarili hizli istek dosyaya yazilmaz; sorunlu ve yavas olanlar kalir.
assert.strictEqual(requestLogLevel(200, 40, false, true), 'debug');
assert.strictEqual(requestLogLevel(201, 40, false, true), 'debug');
assert.strictEqual(requestLogLevel(304, 5, false, true), 'debug');
assert.strictEqual(requestLogLevel(200, SLOW_REQUEST_MS, false, true), 'warn', 'yavas istek');
assert.strictEqual(requestLogLevel(401, 20, false, true), 'info');
assert.strictEqual(requestLogLevel(422, 20, false, true), 'info');
assert.strictEqual(requestLogLevel(503, 5_000, false, true), 'warn', 'DB_BUSY');
assert.strictEqual(requestLogLevel(500, 20, false, true), 'error');
assert.strictEqual(requestLogLevel(200, 20, true, true), 'error', 'yarida kalan istek');
// Gelistirme: her istek gorunur.
assert.strictEqual(requestLogLevel(200, 40, false, false), 'info');

// pino-http kancasi sureyi istegin baslangic damgasindan olcer.
const res = { statusCode: 200, [startTime]: Date.now() - SLOW_REQUEST_MS - 10 };
assert.strictEqual(pinoRequestLevel(true)({} as never, res as unknown as ServerResponse), 'warn');
res[startTime] = Date.now();
assert.strictEqual(pinoRequestLevel(true)({} as never, res as unknown as ServerResponse), 'debug');

console.log('✓ request-log self-check');

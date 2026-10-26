// Veritabani mesgul siniflandirmasi ve genel filtre (GUV-7):
// `ts-node --transpile-only src/common/http/db-busy.selfcheck.ts`
import 'reflect-metadata';
import assert from 'node:assert';
import { Prisma } from '@prisma/client';
import { DB_BUSY, isDatabaseBusyError } from './db-busy';
import { AllExceptionsFilter } from './all-exceptions.filter';

const known = (message: string, code: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'selfcheck' });

// Etkilesimli islem zaman asimlari (P2028): tek baglanti kuyrugunda ya da yedek kilidinde gorulur.
const startTimeout = known(
  'Transaction API error: Unable to start a transaction in the given time.',
  'P2028',
);
const expired = known(
  'Transaction already closed: A query cannot be executed on an expired transaction. The ' +
    'timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the ' +
    'transaction. Consider increasing the interactive transaction timeout or doing less work in ' +
    'the transaction.',
  'P2028',
);
assert.strictEqual(isDatabaseBusyError(startTimeout), true, 'islem baslatilamadi -> mesgul');
assert.strictEqual(isDatabaseBusyError(expired), true, 'islem suresi doldu -> mesgul');
// Kod gelmese de metinden taninir (bilinmeyen istek hatasi olarak sarilmis hali).
assert.strictEqual(
  isDatabaseBusyError(
    new Prisma.PrismaClientUnknownRequestError(
      'Transaction API error: Unable to start a transaction in the given time.',
      { clientVersion: 'selfcheck' },
    ),
  ),
  true,
);
assert.strictEqual(
  isDatabaseBusyError(
    new Prisma.PrismaClientUnknownRequestError('Transaction already closed: expired', {
      clientVersion: 'selfcheck',
    }),
  ),
  true,
);
// Eski siniflar degismedi: soket/havuz zaman asimi mesgul, veri hatalari degil.
assert.strictEqual(
  isDatabaseBusyError(known('Socket timeout (the database failed to respond)', 'P1008')),
  true,
);
assert.strictEqual(isDatabaseBusyError(known('Unique constraint failed', 'P2002')), false);
assert.strictEqual(isDatabaseBusyError(known('Record to update not found.', 'P2025')), false);
// Veritabaniyla ilgisiz zaman asimi (bulut, yazici) mesgul sayilmaz.
assert.strictEqual(isDatabaseBusyError(new Error('fetch timed out')), false);
assert.strictEqual(isDatabaseBusyError(new Error('Transaction already closed')), false);

// Genel filtre: islem zaman asimi istemciye 500 degil 503 DB_BUSY olarak doner.
function runFilter(exception: unknown) {
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
      getRequest: () => ({ method: 'POST', url: '/api/v1/orders/x/items', id: 'r1' }),
    }),
  };
  const filter = new AllExceptionsFilter();
  const logged: string[] = [];
  (filter as unknown as { logger: Record<string, (m: string) => void> }).logger = {
    warn: (m) => logged.push(`warn ${m}`),
    error: (m) => logged.push(`error ${m}`),
  };
  filter.catch(exception, host as never);
  return { status, code: body.error?.code, logged };
}
for (const error of [startTimeout, expired]) {
  const result = runFilter(error);
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.code, DB_BUSY);
  // Beklenen gecici durum: uyari satiri, yigin dokumu yok.
  assert.ok(result.logged.every((line) => line.startsWith('warn ')));
}

console.log('✓ db-busy self-check');

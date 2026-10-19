// Windows yazdirma surucusu self-check'i: takilan yazici zaman asiminda kapatilir, PowerShell
// erken kapanip stdin EPIPE verse de surec cokmez, basarili yazdirma tamamlanir.
// `ts-node --transpile-only src/printing/printing.driver.selfcheck.ts`
import 'reflect-metadata';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { WindowsSpoolerDriver } from './printing.service';
import type { PrintPayload } from './print-text';

type Behavior = 'hang' | 'epipe' | 'ok' | 'fail';

class FakeChild extends EventEmitter {
  killed = false;
  readonly stdin = new EventEmitter() as EventEmitter & {
    end: (data: string, enc: string) => void;
  };
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };

  constructor(behavior: Behavior) {
    super();
    this.stderr.setEncoding = () => undefined;
    this.stdin.end = () => {
      setImmediate(() => {
        if (behavior === 'epipe') {
          // PowerShell erken kapandi: once stdin hatasi, sonra kapanis.
          this.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
          this.stderr.emit('data', 'yazici bulunamadi');
          this.emit('close', 1);
        } else if (behavior === 'ok') {
          this.emit('close', 0);
        } else if (behavior === 'fail') {
          this.stderr.emit('data', 'Erisim engellendi');
          this.emit('close', 1);
        }
        // hang: hic kapanmaz.
      });
    };
  }

  kill() {
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

const payload = { title: 'Mutfak', lines: [] } as unknown as PrintPayload;

function driverFor(behavior: Behavior, timeoutMs = 50) {
  const children: FakeChild[] = [];
  const spawnFn = (() => {
    const child = new FakeChild(behavior);
    children.push(child);
    return child;
  }) as never;
  const driver = new WindowsSpoolerDriver(spawnFn, timeoutMs, 'win32');
  // Kayit gurultusu olmasin.
  (driver as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
  return { driver, children };
}

async function main() {
  // Takilan yazici: zaman asiminda reddedilir ve PowerShell kapatilir.
  const hang = driverFor('hang');
  const started = Date.now();
  await assert.rejects(hang.driver.print(payload, 'windows_spooler', 'PDF'), /yanit vermedi/);
  assert.ok(Date.now() - started < 2000, 'zaman asimi beklenenden uzun surdu');
  assert.strictEqual(hang.children[0]?.killed, true);

  // EPIPE: surec cokmez, hata 'close' ile raporlanir.
  const epipe = driverFor('epipe');
  await assert.rejects(epipe.driver.print(payload, 'windows_spooler', 'Kasa'), /yazici bulunamadi/);

  // Basarisiz yazdirma: stderr metniyle reddedilir.
  const fail = driverFor('fail');
  await assert.rejects(fail.driver.print(payload, 'windows_spooler', 'Kasa'), /Erisim engellendi/);

  // Basarili yazdirma tamamlanir; PowerShell kapatilmaz.
  const ok = driverFor('ok', 5000);
  await ok.driver.print(payload, 'windows_spooler', 'Kasa');
  assert.strictEqual(ok.children[0]?.killed, false);

  // Windows disinda ya da adres yoksa hic PowerShell baslatilmaz.
  const other = new WindowsSpoolerDriver(
    (() => assert.fail('spawn cagrilmamali')) as never,
    50,
    'linux',
  );
  await assert.rejects(other.print(payload, 'windows_spooler', 'Kasa'), /tanimli degil/);

  console.log('✓ printing.driver self-check OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

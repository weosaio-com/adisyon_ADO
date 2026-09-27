// Kalici olay yolu self-check'i: `ts-node --transpile-only src/common/events/event-bus.selfcheck.ts`
// DURABLE_LISTENER'li dinleyici BEKLENMELI ve hatasi worker handler'ina ulasmali
// (worker isi yeniden dener). Islenmemis promise reddi olmamali.
import 'reflect-metadata';
import assert from 'node:assert';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventEmitterModule, OnEvent } from '@nestjs/event-emitter';
import { createDomainEvent, type DomainEvent } from '@ado/shared';
import { EventBusService } from './event-bus.service';
import { DURABLE_LISTENER } from './durable-listener';
import { BackgroundWorkerService } from '../worker/worker.service';

const calls = { ok: 0, logged: 0 };

@Injectable()
class TestListeners {
  @OnEvent('selfcheck.ok', DURABLE_LISTENER)
  async ok(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls.ok += 1;
  }

  @OnEvent('selfcheck.fail', DURABLE_LISTENER)
  async fail(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error('boom');
  }

  // Uretimdeki EventLoggerSubscriber gibi: async + asla hata vermez.
  @OnEvent('**', { async: true })
  log(): void {
    calls.logged += 1;
  }
}

type Handler = (payload: unknown, branchId: string) => Promise<void>;
const handlers = new Map<string, Handler>();
const workerStub = {
  registerHandler: (name: string, handler: Handler) => handlers.set(name, handler),
};

@Module({
  imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', ignoreErrors: false })],
  providers: [
    TestListeners,
    EventBusService,
    { provide: BackgroundWorkerService, useValue: workerStub },
  ],
})
class SelfcheckModule {}

const ev = (name: string): DomainEvent<string, unknown> =>
  createDomainEvent(name, {}, { branchId: 'selfcheck-branch' });

void (async () => {
  const unhandled: unknown[] = [];
  process.on('unhandledRejection', (reason) => unhandled.push(reason));

  const app = await NestFactory.createApplicationContext(SelfcheckModule, { logger: false });
  await app.init();
  const bus = app.get(EventBusService);

  // 1) Basarili dinleyici publish donmeden BITMIS olmali (bekleniyor).
  await bus.publish(ev('selfcheck.ok'), true);
  assert.strictEqual(calls.ok, 1, 'kalici dinleyici beklenmeli');

  // 2) Worker yolu (rethrow=true): dinleyici hatasi yukari cikmali -> is yeniden denenir.
  const domainEventHandler = handlers.get('domain.event');
  assert.ok(domainEventHandler, 'EventBus domain.event handler kaydetmeli');
  await assert.rejects(domainEventHandler(ev('selfcheck.fail'), 'selfcheck-branch'), /boom/);
  await assert.rejects(bus.publish(ev('selfcheck.fail'), true), /boom/);

  // 3) Dogrudan yayin (rethrow=false): hata yutulur, yayinci korunur.
  await bus.publish(ev('selfcheck.fail'), false);

  // Asenkron sarmallarin ve olasi reddedilmis promise'lerin yuzeye cikmasini bekle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(unhandled, [], 'islenmemis promise reddi olmamali');
  assert.ok(calls.logged >= 4, 'wildcard dinleyici de calismali');

  await app.close();
  console.log('event-bus self-check OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

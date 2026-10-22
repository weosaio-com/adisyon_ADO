// Arka plan isi takilmasi (PLT-8): `ts-node --transpile-only src/common/worker/worker.service.selfcheck.ts`
// Sahte veritabani: is satirlari bellekte, `locked` iken her yazma "database is locked" verir.
import 'reflect-metadata';
import assert from 'node:assert';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BackgroundWorkerService, STALE_RUNNING_MS } from './worker.service';
import type { PrismaService } from '../../prisma/prisma.service';

Logger.overrideLogger(false);

interface Row {
  id: string;
  branchId: string;
  taskName: string;
  payload: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lastError?: string | null;
}

const busy = () =>
  new Prisma.PrismaClientKnownRequestError('Socket timeout: database is locked', {
    code: 'P1008',
    clientVersion: 'selfcheck',
  });

function fakeDb() {
  const rows = new Map<string, Row>();
  // locked: tum yazmalar kilitte; updateLocked: yalniz tekil guncelleme (bekci sorgusu gecer).
  const state = { locked: false, updateLocked: false, writes: 0 };
  type Where = {
    id?: string | { notIn: string[] };
    status?: string;
    runAt?: { lte: Date };
    OR?: Array<{ lockedAt: null | { lt: Date } }>;
  };
  const matches = (row: Row, where: Where) => {
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (where.id && typeof where.id === 'object' && where.id.notIn.includes(row.id)) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.runAt && row.runAt > where.runAt.lte) return false;
    if (
      where.OR &&
      !where.OR.some((cond) =>
        cond.lockedAt === null
          ? row.lockedAt === null
          : row.lockedAt !== null && row.lockedAt < cond.lockedAt.lt,
      )
    ) {
      return false;
    }
    return true;
  };
  const apply = (row: Row, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      const op = value as { increment?: number } | null;
      if (op && typeof op === 'object' && 'increment' in op) {
        (row as unknown as Record<string, number>)[key] += op.increment ?? 0;
      } else {
        (row as unknown as Record<string, unknown>)[key] = value;
      }
    }
  };
  const write = () => {
    state.writes++;
    if (state.locked) throw busy();
  };
  const backgroundJob = {
    findMany: async ({ where }: { where: Where }) =>
      [...rows.values()].filter((row) => matches(row, where)).map((row) => ({ ...row })),
    updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      write();
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, where)) continue;
        apply(row, data);
        count++;
      }
      return { count };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...rows.get(where.id)! }),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      write();
      if (state.updateLocked) throw busy();
      const row = rows.get(where.id);
      if (!row) {
        throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
          code: 'P2025',
          clientVersion: 'selfcheck',
        });
      }
      apply(row, data);
      return { ...row };
    },
  };
  const prisma = {
    backgroundJob,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  const add = (id: string, extra: Partial<Row> = {}) =>
    rows.set(id, {
      id,
      branchId: 'b1',
      taskName: 'domain.event',
      payload: '{}',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      runAt: new Date(0),
      lockedAt: null,
      ...extra,
    });
  return { prisma: prisma as unknown as PrismaService, rows, state, add };
}

function newWorker(prisma: PrismaService) {
  const worker = new BackgroundWorkerService(prisma);
  // Hizli test: sonuc yazma yeniden denemesi kisa beklemeli.
  (worker as unknown as { resultRetryDelaysMs: number[] }).resultRetryDelaysMs = [5, 5];
  return worker;
}

async function main() {
  // 1. Is kilitte duser, hata kaydi da kilide takilir (kanit: .audit/worker/stuck-running.ts).
  //    Eskiden is "running"de kaliyordu; simdi sonuc bellekte bekler, kilit kalkinca yazilir.
  {
    const db = fakeDb();
    db.add('j1');
    const worker = newWorker(db.prisma);
    let calls = 0;
    worker.registerHandler('domain.event', async () => {
      calls++;
      db.state.locked = true; // ornegin yedek alinirken
      throw busy();
    });
    await worker.processNextJobs(); // tur hatasi firlatmaz
    assert.strictEqual(db.rows.get('j1')!.status, 'running', 'kilit surerken veritabani yazilamaz');
    db.state.locked = false;
    await worker.processNextJobs();
    const row = db.rows.get('j1')!;
    assert.strictEqual(
      row.status,
      'pending',
      'kilit kalkinca hata kaydi yazilir, is kuyruga doner',
    );
    assert.ok(row.runAt.getTime() > Date.now(), 'normal geri cekilmeyle tekrar denenecek');
    assert.match(row.lastError ?? '', /locked/);
    assert.strictEqual(calls, 1, 'sonuc yazilirken is yeniden calistirilmaz');
  }

  // 2. Kisa kilit: hata kaydi kisa beklemeyle yeniden denenir, ayni turda yazilir.
  {
    const db = fakeDb();
    db.add('j2');
    const worker = newWorker(db.prisma);
    worker.registerHandler('domain.event', async () => {
      db.state.locked = true;
      setTimeout(() => (db.state.locked = false), 3); // ilk denemeden sonra kalkar
      throw busy();
    });
    await worker.processNextJobs();
    assert.strictEqual(db.rows.get('j2')!.status, 'pending');
  }

  // 3. Basarili is, "tamamlandi" yazilamadi: is tekrar calismaz (fis iki kez basilmaz), sonuc yazilir.
  {
    const db = fakeDb();
    db.add('j3');
    const worker = newWorker(db.prisma);
    let calls = 0;
    worker.registerHandler('domain.event', async () => {
      calls++;
      db.state.locked = true;
    });
    await worker.processNextJobs();
    db.state.locked = false;
    await worker.processNextJobs();
    await worker.processNextJobs();
    assert.strictEqual(db.rows.get('j3')!.status, 'completed');
    assert.strictEqual(calls, 1);
  }

  // 4. Bekci: bu surecte calismayan, kilidi eski "running" is program acikken kuyruga doner;
  //    yeni kilitli is (baska bir turda calisiyor olabilir) beklenir.
  {
    const db = fakeDb();
    const old = new Date(Date.now() - STALE_RUNNING_MS - 1_000);
    db.add('stale', { status: 'running', lockedAt: old, attempts: 1 });
    db.add('fresh', { status: 'running', lockedAt: new Date(), attempts: 1 });
    db.add('nolock', { status: 'running', lockedAt: null, attempts: 1 });
    const worker = newWorker(db.prisma);
    const seen: string[] = [];
    worker.registerHandler('domain.event', async (payload) => {
      seen.push(String((payload as { id?: string }).id));
    });
    db.rows.get('stale')!.payload = '{"id":"stale"}';
    db.rows.get('nolock')!.payload = '{"id":"nolock"}';
    await worker.processNextJobs();
    assert.strictEqual(db.rows.get('stale')!.status, 'completed', 'takili is yeniden calisti');
    assert.strictEqual(db.rows.get('nolock')!.status, 'completed');
    assert.strictEqual(db.rows.get('fresh')!.status, 'running', 'yeni kilitli ise dokunulmaz');
    assert.deepStrictEqual(seen.sort(), ['nolock', 'stale']);
    // Bekci her turda sorgu atmaz (en fazla 30 sn'de bir).
    const writes = db.state.writes;
    await worker.processNextJobs();
    assert.strictEqual(db.state.writes, writes);
  }

  // 5. Bekci sonucu bekleyen (yazilamamis) ise dokunmaz: is iki kez calismaz.
  {
    const db = fakeDb();
    db.add('j5');
    const worker = newWorker(db.prisma);
    let calls = 0;
    worker.registerHandler('domain.event', async () => {
      calls++;
      db.state.locked = true;
    });
    await worker.processNextJobs();
    db.rows.get('j5')!.lockedAt = new Date(Date.now() - STALE_RUNNING_MS - 1_000);
    (worker as unknown as { lastStaleCheck: number }).lastStaleCheck = 0;
    db.state.locked = false;
    db.state.updateLocked = true; // sonuc hala yazilamiyor, bekci sorgusu calisiyor
    await worker.processNextJobs();
    assert.strictEqual(db.rows.get('j5')!.status, 'running', 'bekci sonucu bekleyen ise dokunmaz');
    db.state.updateLocked = false;
    await worker.processNextJobs();
    assert.strictEqual(db.rows.get('j5')!.status, 'completed');
    assert.strictEqual(calls, 1);
  }

  console.log('✓ worker.service self-check');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

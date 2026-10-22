import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newId } from '@ado/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { isDatabaseBusyError } from '../http/db-busy';

export type JobHandler = (payload: unknown, branchId: string) => Promise<void>;

/** Isin sonucu (tamamlandi / hata) veritabani mesgulse bu beklemelerle yeniden yazilir. */
export const RESULT_RETRY_DELAYS_MS = [250, 1_000];
/**
 * Bekci: bu surecte calismayan ve kilidi bu sureden eski "running" is yarim kalmistir (sonucu
 * yazilamamis); program acikken kuyruga doner. Eskiden ancak yeniden baslatmada donuyordu (PLT-8).
 */
export const STALE_RUNNING_MS = 60_000;
/** Bekcinin sorgusu en fazla bu aralikla calisir (her saniyelik turda degil). */
export const STALE_CHECK_INTERVAL_MS = 30_000;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isNotFound = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class BackgroundWorkerService implements OnModuleInit {
  private readonly logger = new Logger(BackgroundWorkerService.name);
  private readonly handlers = new Map<string, JobHandler>();
  /** Bu surecte su an calisan isler: bekci bunlara dokunmaz. */
  private readonly active = new Set<string>();
  /**
   * Yazilamamis sonuclar (veritabani uzun sure mesguldu). Is yeniden CALISTIRILMAZ (mutfak fisi
   * iki kez basilmasin); yalniz sonucu sonraki turlarda yazilir.
   */
  private readonly unsaved = new Map<string, Prisma.BackgroundJobUpdateInput>();
  private lastStaleCheck = 0;
  protected resultRetryDelaysMs = RESULT_RETRY_DELAYS_MS;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Veritabanini tek backend kullanir (masaustu tek kopya kilidi): acilista "running" kalan her is
    // onceki surecte yarim kalmistir. Beklemeden yeniden kuyruklanir; hizli yeniden baslatmada is
    // (or. QR menu yayini) "suruyor" gorunup takili kalmaz.
    const recovered = await this.prisma.backgroundJob.updateMany({
      where: { status: 'running' },
      data: { status: 'pending', lockedAt: null, runAt: new Date() },
    });
    if (recovered.count)
      this.logger.warn(`${recovered.count} yarim kalmis is yeniden kuyruklandi.`);
    this.logger.log('Background Worker Service initialized');
  }

  registerHandler(taskName: string, handler: JobHandler) {
    if (this.handlers.has(taskName)) {
      this.logger.warn(`Handler for task "${taskName}" is already registered. Overwriting.`);
    }
    this.handlers.set(taskName, handler);
    this.logger.log(`Task handler registered: ${taskName}`);
  }

  async enqueue(
    branchId: string,
    taskName: string,
    payload: unknown,
    delaySeconds = 0,
  ): Promise<string> {
    const id = newId();
    const runAt = new Date(Date.now() + delaySeconds * 1000);
    const serializedPayload = JSON.stringify(payload);

    await this.prisma.backgroundJob.create({
      data: {
        id,
        branchId,
        taskName,
        payload: serializedPayload,
        status: 'pending',
        runAt,
      },
    });

    this.logger.debug(`Enqueued job ${taskName} (${id}) to run at ${runAt.toISOString()}`);
    return id;
  }

  async processNextJobs(): Promise<number> {
    await this.flushUnsavedResults();
    await this.requeueStaleRunning();
    const now = new Date();
    // Tek turda kisa sureli POS yogunlugunu erit; kilit her isi yine tek sahipli yapar.
    const jobs = await this.prisma.backgroundJob.findMany({
      where: {
        status: 'pending',
        runAt: { lte: now },
      },
      orderBy: { runAt: 'asc' },
      take: 20,
    });

    if (jobs.length === 0) return 0;

    this.logger.debug(`Found ${jobs.length} jobs to process.`);

    for (const job of jobs) {
      await this.runJob(job.id);
    }

    return jobs.length;
  }

  private async runJob(id: string) {
    this.active.add(id);
    try {
      await this.lockAndRun(id);
    } finally {
      this.active.delete(id);
    }
  }

  private async lockAndRun(id: string) {
    // Kilitliyoruz
    const job = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.backgroundJob.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'running',
          lockedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      if (locked.count !== 1) return null;
      return tx.backgroundJob.findUniqueOrThrow({ where: { id } });
    });

    if (!job) return;

    this.logger.log(`Running job "${job.taskName}" (${job.id}), attempt #${job.attempts}`);

    const handler = this.handlers.get(job.taskName);
    if (!handler) {
      const errMsg = `No handler registered for task "${job.taskName}"`;
      this.logger.error(errMsg);
      await this.handleJobFailure(job.id, job.attempts, job.maxAttempts, errMsg);
      return;
    }

    try {
      const parsedPayload = JSON.parse(job.payload);
      await handler(parsedPayload, job.branchId);
    } catch (err) {
      const errMsg = errorMessage(err);
      this.logger.error(`Job "${job.taskName}" (${job.id}) failed with error: ${errMsg}`);
      await this.handleJobFailure(job.id, job.attempts, job.maxAttempts, errMsg);
      return;
    }

    // Basariyla bitti. Sonuc yazilamazsa is tekrar calistirilmaz (yalniz sonuc yeniden yazilir).
    if (await this.saveResult(job.id, { status: 'completed', completedAt: new Date() })) {
      this.logger.log(`Job "${job.taskName}" (${job.id}) completed successfully.`);
    }
  }

  private async handleJobFailure(id: string, attempts: number, maxAttempts: number, error: string) {
    if (attempts < maxAttempts) {
      // Yeniden dene
      const backoffSeconds = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
      const nextRun = new Date(Date.now() + backoffSeconds * 1000);
      const saved = await this.saveResult(id, {
        status: 'pending',
        runAt: nextRun,
        lastError: error,
        lockedAt: null,
      });
      if (saved) {
        this.logger.warn(
          `Job ${id} scheduled for retry at ${nextRun.toISOString()} (backoff: ${backoffSeconds}s)`,
        );
      }
    } else {
      // Kalici basarisiz
      const saved = await this.saveResult(id, {
        status: 'failed',
        failedAt: new Date(),
        lastError: error,
      });
      if (saved) this.logger.error(`Job ${id} failed permanently after ${attempts} attempts.`);
    }
  }

  /**
   * Isin sonucunu yazar. Veritabani mesgulse (yedek/rapor kilidi) kisa beklemelerle yeniden dener;
   * yine yazilamazsa sonuc bellekte tutulur ve sonraki turlarda yazilir. Eskiden bu yazma hatasi
   * yakalanmiyordu: is "running"de kaliyor, fis ancak program yeniden baslatilinca basiliyordu.
   */
  private async saveResult(id: string, data: Prisma.BackgroundJobUpdateInput): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.prisma.backgroundJob.update({ where: { id }, data });
        return true;
      } catch (err) {
        if (isNotFound(err)) return false; // is silinmis (bakim temizligi): yazacak bir sey yok
        const delay = this.resultRetryDelaysMs[attempt];
        if (isDatabaseBusyError(err) && delay !== undefined) {
          await sleep(delay);
          continue;
        }
        this.unsaved.set(id, data);
        this.logger.warn(
          `Is ${id} sonucu yazilamadi, sonraki turlarda yeniden yazilacak: ${errorMessage(err)}`,
        );
        return false;
      }
    }
  }

  /** Bekleyen sonuclari yazar; veritabani hala mesgulse sonraki tura birakir. */
  private async flushUnsavedResults() {
    for (const [id, data] of this.unsaved) {
      try {
        await this.prisma.backgroundJob.update({ where: { id }, data });
        this.unsaved.delete(id);
        this.logger.log(`Is ${id} sonucu gecikmeli olarak yazildi (${String(data.status)}).`);
      } catch (err) {
        if (isNotFound(err)) {
          this.unsaved.delete(id);
          continue;
        }
        return; // hala mesgul: siradaki turda
      }
    }
  }

  /** Bekci: sonucu yazilamamis ve bu surecte calismayan eski "running" isleri kuyruga dondurur. */
  private async requeueStaleRunning(now = Date.now()) {
    if (now - this.lastStaleCheck < STALE_CHECK_INTERVAL_MS) return;
    this.lastStaleCheck = now;
    const keep = [...this.active, ...this.unsaved.keys()];
    try {
      const stale = await this.prisma.backgroundJob.updateMany({
        where: {
          status: 'running',
          OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now - STALE_RUNNING_MS) } }],
          ...(keep.length ? { id: { notIn: keep } } : {}),
        },
        data: { status: 'pending', lockedAt: null, runAt: new Date(now) },
      });
      if (stale.count) {
        this.logger.warn(`${stale.count} takili kalmis is ("running") yeniden kuyruklandi.`);
      }
    } catch (err) {
      this.logger.warn(`Takili is denetimi yapilamadi: ${errorMessage(err)}`);
    }
  }
}

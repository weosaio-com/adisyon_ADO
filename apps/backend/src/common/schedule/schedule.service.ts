import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { BackgroundWorkerService } from '../worker/worker.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  /** Su an turu suren seritler: ayni serit ust uste binmez, seritler birbirini beklemez. */
  private readonly running = new Set<string>();

  constructor(private readonly worker: BackgroundWorkerService) {}

  @Interval(1000)
  async handleWorkerTick() {
    // Yavas serit (QR menu yayini) turunu surdururken mutfak fisi seridi her saniye turlamaya
    // devam eder (PLT-7). Donen soz yalniz bu turda baslatilan seritleri bekler (testler icin).
    await Promise.all(this.worker.lanes().map((lane) => this.tickLane(lane)));
  }

  private async tickLane(lane: string) {
    if (this.running.has(lane)) return;
    this.running.add(lane);
    try {
      await this.worker.processNextJobs(lane);
    } catch (err) {
      this.logger.error(`Error in background worker tick (${lane}):`, err);
    } finally {
      this.running.delete(lane);
    }
  }
}

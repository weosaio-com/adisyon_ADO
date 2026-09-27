import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DURABLE_LISTENER } from '../common/events/durable-listener';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { newId, PrintJobStatus, DocumentType, type DomainEvent } from '@ado/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BackgroundWorkerService } from '../common/worker/worker.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type {
  CreatePrinterDto,
  UpdatePrinterDto,
  CreatePrintRouteDto,
} from './dto/printing.schemas';
import {
  decodePrinterList,
  encodeForPowerShell,
  POWERSHELL_LIST_PRINTERS_SCRIPT,
  POWERSHELL_PRINT_SCRIPT,
  PRINTER_ENV,
  printSummary,
  printText,
  type PrintPayload,
} from './print-text';

const execFileAsync = promisify(execFile);
// Basarisiz fis listesi (ve masa ekranindaki uyari) bu pencereye bakar.
const JOB_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Surucunun buldugu yazici: kaydederken connection/address aynen kullanilir. */
type DiscoveredPrinter = { name: string; connection: string; address: string };
type PrintableOrder = Prisma.OrderGetPayload<{
  include: { items: { include: { product: true } } };
}>;

export interface PrinterDriver {
  print(payload: PrintPayload, connection: string, address: string | null): Promise<void>;
  discover(): Promise<DiscoveredPrinter[]>;
  getCapabilities(): Record<string, boolean>;
}

class MockPrinterDriver implements PrinterDriver {
  private readonly logger = new Logger(MockPrinterDriver.name);

  async print(payload: PrintPayload, connection: string, address: string | null): Promise<void> {
    this.logger.log(`[PRINT SIMULATION] connection=${connection}, address=${address}`);
    this.logger.log(`[PRINT CONTENT] ${JSON.stringify(payload, null, 2)}`);
  }

  async discover(): Promise<DiscoveredPrinter[]> {
    return [
      { name: 'Simülasyon yazıcı (fiş loga yazılır)', connection: 'usb', address: 'mock-usb-1' },
    ];
  }

  getCapabilities() {
    return { cutter: true, drawer: true, qr: true };
  }
}

class WindowsSpoolerDriver implements PrinterDriver {
  async print(payload: PrintPayload, connection: string, address: string | null): Promise<void> {
    if (process.platform !== 'win32' || connection !== 'windows_spooler' || !address) {
      throw new Error('Windows spooler yazici adi tanimli degil.');
    }
    await new Promise<void>((resolve, reject) => {
      // Yazici adi env ile (bosluk/Turkce karakter guvenli); metin stdin'den base64.
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PRINT_SCRIPT],
        {
          env: { ...process.env, [PRINTER_ENV]: address },
          stdio: ['pipe', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      let error = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => (error += chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(error.trim() || `Print exit ${code}`)),
      );
      // Base64: PowerShell stdin'i OEM kod sayfasiyla okur; Turkce karakterler bozulmasin.
      child.stdin.end(encodeForPowerShell(printText(payload)), 'ascii');
    });
  }

  async discover(): Promise<DiscoveredPrinter[]> {
    if (process.platform !== 'win32') return [];
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_LIST_PRINTERS_SCRIPT],
      { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
    );
    return decodePrinterList(stdout).map((name) => ({
      name,
      connection: 'windows_spooler',
      address: name,
    }));
  }

  getCapabilities() {
    return { cutter: false, drawer: false, qr: false };
  }
}

@Injectable()
export class PrintingService implements OnModuleInit {
  private readonly logger = new Logger(PrintingService.name);
  private readonly drivers = new Map<string, PrinterDriver>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: BackgroundWorkerService,
  ) {}

  onModuleInit() {
    // Referans sürücüyü kaydet
    this.drivers.set('windows-spooler', new WindowsSpoolerDriver());
    if (process.env.NODE_ENV !== 'production') {
      this.drivers.set('escpos-mock', new MockPrinterDriver());
    }
    this.logger.log('Printer drivers initialized.');

    // Arka plan iş kuyruğu dinleyicisini kaydet
    this.worker.registerHandler('print.job', async (payload, _branchId: string) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('jobId' in payload) ||
        typeof payload.jobId !== 'string'
      ) {
        throw new Error('Gecersiz print.job payload.');
      }
      await this.executePrintJob(payload.jobId);
    });
  }

  // ===========================================================================
  // Printer CRUD
  // ===========================================================================
  async createPrinter(user: AuthUser, dto: CreatePrinterDto) {
    if (!this.drivers.has(dto.driverId)) {
      throw new NotFoundException('Yazici surucusu bulunamadi.');
    }
    const id = newId();

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        // Diğer varsayılanları kaldır
        await tx.printer.updateMany({
          where: { branchId: user.branchId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.printer.create({
        data: {
          id,
          branchId: user.branchId,
          name: dto.name,
          driverId: dto.driverId,
          connection: dto.connection,
          address: dto.address ?? null,
          paperWidth: dto.paperWidth,
          isDefault: dto.isDefault,
          capabilities: dto.capabilities ?? null,
          isActive: dto.isActive,
          deviceId: user.deviceId ?? null,
        },
      });
    });
  }

  async updatePrinter(user: AuthUser, id: string, dto: UpdatePrinterDto) {
    const printer = await this.prisma.printer.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!printer) throw new NotFoundException('Yazıcı bulunamadı.');

    if (dto.driverId && !this.drivers.has(dto.driverId)) {
      throw new NotFoundException('Yazici surucusu bulunamadi.');
    }
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.printer.updateMany({
          where: { branchId: user.branchId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      const data: Prisma.PrinterUpdateInput = {
        version: { increment: 1 },
      };
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.driverId !== undefined) data.driverId = dto.driverId;
      if (dto.connection !== undefined) data.connection = dto.connection;
      if (dto.address !== undefined) data.address = dto.address ?? null;
      if (dto.paperWidth !== undefined) data.paperWidth = dto.paperWidth;
      if (dto.isDefault !== undefined) data.isDefault = dto.isDefault;
      if (dto.capabilities !== undefined) data.capabilities = dto.capabilities ?? null;
      if (dto.isActive !== undefined) data.isActive = dto.isActive;

      return tx.printer.update({
        where: { id },
        data,
      });
    });
  }

  async deletePrinter(user: AuthUser, id: string) {
    const printer = await this.prisma.printer.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!printer) throw new NotFoundException('Yazıcı bulunamadı.');

    // Yaziciya bagli rotalar da kalkar: yoksa ayni fis turune yeni rota "zaten tanimli" hatasi verir.
    const deletedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.printer.update({
        where: { id },
        data: { deletedAt, version: { increment: 1 } },
      }),
      this.prisma.printRoute.updateMany({
        where: { printerId: id, deletedAt: null },
        data: { deletedAt, version: { increment: 1 } },
      }),
    ]);
    return { success: true };
  }

  async listPrinters(user: AuthUser) {
    return this.prisma.printer.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  // ===========================================================================
  // Print Route CRUD
  // ===========================================================================
  async createRoute(user: AuthUser, dto: CreatePrintRouteDto) {
    // Yazıcıyı doğrula
    const printer = await this.prisma.printer.findFirst({
      where: {
        id: dto.printerId,
        branchId: user.branchId,
        deletedAt: null,
        isActive: true,
      },
    });
    if (!printer) throw new NotFoundException('Yazıcı bulunamadı.');

    // Çakışan rotayı kontrol et
    const existing = await this.prisma.printRoute.findFirst({
      where: {
        branchId: user.branchId,
        documentType: dto.documentType,
        categoryId: dto.categoryId ?? null,
        deletedAt: null,
        printer: { deletedAt: null },
      },
    });
    if (existing) {
      throw new ConflictException('Bu rota tipi için zaten bir yönlendirme tanımlı.');
    }

    const id = newId();
    return this.prisma.printRoute.create({
      data: {
        id,
        branchId: user.branchId,
        documentType: dto.documentType,
        printerId: dto.printerId,
        categoryId: dto.categoryId ?? null,
        deviceId: user.deviceId ?? null,
      },
    });
  }

  async deleteRoute(user: AuthUser, id: string) {
    const route = await this.prisma.printRoute.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!route) throw new NotFoundException('Rota bulunamadı.');

    await this.prisma.printRoute.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });
    return { success: true };
  }

  async listRoutes(user: AuthUser) {
    return this.prisma.printRoute.findMany({
      where: { branchId: user.branchId, deletedAt: null, printer: { deletedAt: null } },
      include: { printer: true },
    });
  }

  // Kurulum ekrani: suruculerin buldugu yazicilar. Bir surucu hata verirse
  // (PowerShell yok/zaman asimi) digerleri yine listelenir; yazici adi elle de girilebilir.
  async discoverPrinters() {
    const found: Array<DiscoveredPrinter & { driverId: string }> = [];
    for (const [driverId, driver] of this.drivers) {
      try {
        for (const printer of await driver.discover()) found.push({ driverId, ...printer });
      } catch (err) {
        this.logger.warn(`Yazici taramasi basarisiz (${driverId}): ${String(err)}`);
      }
    }
    return found;
  }

  // Son 24 saatin fisleri (en yeni once). `text`: yaziciya giden metnin aynisi (onizleme).
  async listJobs(user: AuthUser, status?: string) {
    const jobs = await this.prisma.printJob.findMany({
      where: {
        branchId: user.branchId,
        deletedAt: null,
        createdAt: { gte: new Date(Date.now() - JOB_LIST_WINDOW_MS) },
        ...(status ? { status } : {}),
      },
      include: { printer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs.map((job) => {
      const payload = JSON.parse(job.payload) as PrintPayload;
      return {
        id: job.id,
        documentType: job.documentType,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        createdAt: job.createdAt,
        printedAt: job.printedAt,
        printerId: job.printerId,
        printerName: job.printer.name,
        summary: printSummary(payload),
        text: printText(payload),
      };
    });
  }

  // Basarisiz fisi yeniden kuyruga alir (kagit bitti, yazici kapaliydi...).
  async retryJob(user: AuthUser, id: string) {
    const job = await this.failedJobOrThrow(user, id);
    await this.prisma.$transaction([
      this.prisma.printJob.update({
        where: { id: job.id },
        data: { status: PrintJobStatus.Queued, lastError: null },
      }),
      this.prisma.backgroundJob.create({
        data: {
          id: newId(),
          branchId: user.branchId,
          taskName: 'print.job',
          payload: JSON.stringify({ jobId: job.id }),
          status: 'pending',
          runAt: new Date(),
        },
      }),
    ]);
    return { ok: true };
  }

  // Basarisiz fisi listeden kaldirir (artik basilmasi gerekmiyor).
  async dismissJob(user: AuthUser, id: string) {
    const job = await this.failedJobOrThrow(user, id);
    await this.prisma.printJob.update({ where: { id: job.id }, data: { deletedAt: new Date() } });
    return { ok: true };
  }

  private async failedJobOrThrow(user: AuthUser, id: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!job) {
      throw new NotFoundException({ code: 'PRINT_JOB_NOT_FOUND', message: 'Fiş bulunamadı.' });
    }
    if (job.status !== PrintJobStatus.Failed) {
      throw new ConflictException({
        code: 'PRINT_JOB_NOT_FAILED',
        message: 'Yalnız yazdırılamayan fiş tekrar denenebilir veya kaldırılabilir.',
      });
    }
    return job;
  }

  // ===========================================================================
  // Print Job Lifecycle
  // ===========================================================================
  async enqueuePrintJob(
    branchId: string,
    printerId: string,
    documentType: string,
    payload: PrintPayload,
    createdBy: string,
    receipt?: { orderId: string; orderNo: string; type: string },
    sourceEventId?: string,
  ): Promise<string> {
    if (sourceEventId) {
      const existing = await this.prisma.printJob.findUnique({
        where: {
          sourceEventId_printerId_documentType: {
            sourceEventId,
            printerId,
            documentType,
          },
        },
      });
      if (existing) return existing.id;
    }
    const id = newId();

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.printJob.create({
          data: {
            id,
            branchId,
            printerId,
            documentType,
            sourceEventId: sourceEventId ?? null,
            payload: JSON.stringify(payload),
            status: PrintJobStatus.Queued,
            createdBy,
          },
        });
        await tx.backgroundJob.create({
          data: {
            id: newId(),
            branchId,
            taskName: 'print.job',
            payload: JSON.stringify({ jobId: id }),
            status: 'pending',
            runAt: new Date(),
          },
        });
        if (receipt) {
          const seq = await tx.receipt.count({
            where: { orderId: receipt.orderId, type: receipt.type },
          });
          await tx.receipt.create({
            data: {
              id: newId(),
              orderId: receipt.orderId,
              receiptNo: `${receipt.orderNo}-${receipt.type[0]!.toUpperCase()}${seq + 1}`,
              type: receipt.type,
              printedAt: null,
              printJobId: id,
              printerId,
              contentSnapshot: JSON.stringify(payload),
            },
          });
        }
      });
    } catch (error) {
      if (
        sourceEventId &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.printJob.findUnique({
          where: {
            sourceEventId_printerId_documentType: {
              sourceEventId,
              printerId,
              documentType,
            },
          },
        });
        if (existing) return existing.id;
      }
      throw error;
    }

    // Worker'a gönder
    return id;
  }

  private async executePrintJob(jobId: string) {
    const job = await this.prisma.printJob.findUnique({
      where: { id: jobId },
      include: { printer: true },
    });

    // Kaldirilan (yoksayilan) fis, bekleyen otomatik denemede de basilmaz.
    if (!job || job.deletedAt || job.status === PrintJobStatus.Done) return;
    if (!job.printer.isActive || job.printer.deletedAt) {
      throw new Error('Yazici aktif degil.');
    }

    await this.prisma.printJob.update({
      where: { id: jobId },
      data: { status: PrintJobStatus.Printing, attempts: { increment: 1 } },
    });

    const driver = this.drivers.get(job.printer.driverId);
    if (!driver) {
      const errorMsg = `Driver not found for printing: ${job.printer.driverId}`;
      this.logger.error(errorMsg);
      await this.prisma.printJob.update({
        where: { id: jobId },
        data: { status: PrintJobStatus.Failed, lastError: errorMsg },
      });
      throw new Error(errorMsg);
    }

    try {
      const parsedPayload = JSON.parse(job.payload) as PrintPayload;
      await driver.print(parsedPayload, job.printer.connection, job.printer.address);

      const printedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.printJob.update({
          where: { id: jobId },
          data: { status: PrintJobStatus.Done, printedAt },
        });
        await tx.receipt.updateMany({
          where: { printJobId: jobId },
          data: { printedAt },
        });
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.prisma.printJob.update({
        where: { id: jobId },
        data: { status: PrintJobStatus.Failed, lastError: errorMsg },
      });
      throw err;
    }
  }

  // ===========================================================================
  // Domain Event Abonesi
  // ===========================================================================
  @OnEvent('order.paid', DURABLE_LISTENER)
  async handleOrderPaid(event: DomainEvent<'order.paid', { orderId: string }>) {
    const { orderId } = event.payload;
    this.logger.log(`Received order.paid event for order: ${orderId}`);

    // Sipariş verilerini DB'den çek (iptal/silinmiş kalemler fişe girmez)
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId: event.branchId, deletedAt: null },
      include: {
        items: {
          where: { deletedAt: null, status: { not: 'cancelled' } },
          include: { product: true },
        },
      },
    });

    if (!order) {
      this.logger.error(`Order not found for printing receipt: ${orderId}`);
      return;
    }

    // order.paid her ödemede yayınlanır; müşteri fişi yalnız adisyon tamamen
    // ödenince (split'in son ödemesi) bir kez basılır — mükerrer fiş önlenir.
    if (!order.isPaid) return;

    const printerId = await this.resolveCustomerPrinterId(event.branchId);
    if (!printerId) {
      this.logger.warn(
        `No print route or default printer configured for customer receipts in branch ${event.branchId}`,
      );
      return;
    }

    const printDoc = this.buildCustomerDoc(order, 'MÜŞTERİ FİŞİ — ÖDENDİ');
    await this.enqueuePrintJob(
      event.branchId,
      printerId,
      DocumentType.Customer,
      printDoc,
      event.actorId || 'system',
      { orderId: order.id, orderNo: order.orderNo, type: DocumentType.Customer },
      `order:${order.id}:paid`,
    );
  }

  // Müşteri fişi yazıcısı: önce rota, yoksa varsayılan yazıcı.
  private async resolveCustomerPrinterId(branchId: string): Promise<string | undefined> {
    const route = await this.prisma.printRoute.findFirst({
      where: {
        branchId,
        documentType: DocumentType.Customer,
        deletedAt: null,
        printer: { isActive: true, deletedAt: null },
      },
    });
    if (route?.printerId) return route.printerId;
    const defaultPrinter = await this.prisma.printer.findFirst({
      where: { branchId, isDefault: true, isActive: true, deletedAt: null },
    });
    return defaultPrinter?.id;
  }

  // Soyut PrintDocument (müşteri fişi / hesap fişi ortak gövde). Başlık ayırt eder.
  private buildCustomerDoc(order: PrintableOrder, title: string): PrintPayload {
    return {
      title,
      orderNo: order.orderNo,
      date: order.openedAt.toISOString(),
      items: order.items.map((item) => ({
        name: item.productNameSnapshot || item.product.name,
        quantity: item.quantity / 1000,
        price: item.unitPrice / 100,
        total: item.lineTotal / 100,
      })),
      discount: (order.discountTotal || 0) / 100,
      grandTotal: (order.grandTotal || 0) / 100,
    };
  }

  // Ödeme ÖNCESİ hesap/adisyon fişi (talep üzerine). Ödeme almaz; fiş
  // Receipt.type='bill' olarak kaydedilir (rapordan görülebilir).
  async printBill(user: AuthUser, orderId: string): Promise<{ ok: boolean }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId: user.branchId, deletedAt: null },
      include: {
        items: {
          where: { deletedAt: null, status: { not: 'cancelled' } },
          include: { product: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadı.' });
    }

    const printerId = await this.resolveCustomerPrinterId(user.branchId);
    if (!printerId) {
      throw new ConflictException({
        code: 'NO_CUSTOMER_PRINTER',
        message: 'Müşteri fişi için yazıcı/rota tanımlı değil.',
      });
    }

    const printDoc = this.buildCustomerDoc(order, '*** HESAP *** (Ödeme alınmadı)');
    await this.enqueuePrintJob(
      user.branchId,
      printerId,
      DocumentType.Customer,
      printDoc,
      user.userId,
      { orderId: order.id, orderNo: order.orderNo, type: 'bill' },
    );
    return { ok: true };
  }

  @OnEvent('order.item.sent', DURABLE_LISTENER)
  async handleOrderItemSent(
    event: DomainEvent<
      'order.item.sent',
      {
        orderId: string;
        items: Array<{
          productId: string;
          productName: string;
          quantity: number;
          orderItemId: string;
        }>;
      }
    >,
  ) {
    const { orderId, items } = event.payload;
    this.logger.log(`Received order.item.sent for order: ${orderId} (${items.length} kalem)`);

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId: event.branchId, deletedAt: null },
    });
    if (!order) {
      this.logger.error(`Order not found for kitchen ticket: ${orderId}`);
      return;
    }

    // Kalem -> kategori haritasi (olay yuku categoryId tasimaz, urunden cozulur).
    const productIds = [
      ...new Set(items.map((i: { productId?: string }) => i.productId).filter(Boolean)),
    ] as string[];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, branchId: event.branchId, deletedAt: null },
      select: { id: true, categoryId: true },
    });
    const catOf = new Map(products.map((p) => [p.id, p.categoryId]));

    // Hazirlik rotalari (mutfak + bar). categoryId'li rota o kategoriyi ilgili
    // yaziciya ( or. bar) yonlendirir; categoryId'siz rota genel mutfak fallback'i.
    const routes = await this.prisma.printRoute.findMany({
      where: {
        branchId: event.branchId,
        documentType: { in: [DocumentType.Kitchen, DocumentType.Bar] },
        deletedAt: null,
        printer: { isActive: true, deletedAt: null },
      },
    });
    type Target = { printerId: string; documentType: string };
    const byCategory = new Map<string, Target>();
    let general: Target | undefined;
    for (const r of routes) {
      if (r.categoryId) {
        byCategory.set(r.categoryId, { printerId: r.printerId, documentType: r.documentType });
      } else if (!general || r.documentType === DocumentType.Kitchen) {
        general = { printerId: r.printerId, documentType: r.documentType };
      }
    }
    if (!general) {
      const def = await this.prisma.printer.findFirst({
        where: {
          branchId: event.branchId,
          isDefault: true,
          isActive: true,
          deletedAt: null,
        },
      });
      if (def) general = { printerId: def.id, documentType: DocumentType.Kitchen };
    }

    // Kalemleri hedef (yazici + belge tipi) bazinda grupla -> ayri bar/mutfak fisleri.
    const groups = new Map<string, Target & { items: typeof items }>();
    for (const it of items) {
      const catId = catOf.get(it.productId);
      const target = (catId && byCategory.get(catId)) || general;
      if (!target) continue;
      const key = `${target.printerId}:${target.documentType}`;
      if (!groups.has(key)) groups.set(key, { ...target, items: [] });
      groups.get(key)!.items.push(it);
    }
    if (groups.size === 0) {
      this.logger.warn(`No kitchen/bar route or default printer for branch ${event.branchId}`);
      return;
    }

    for (const g of groups.values()) {
      const printDoc = {
        title: g.documentType === DocumentType.Bar ? 'BAR FİŞİ' : 'MUTFAK FİŞİ',
        orderNo: order.orderNo,
        date: new Date().toISOString(),
        items: g.items.map((i: { productName: string; quantity: number }) => ({
          name: i.productName,
          quantity: i.quantity / 1000,
        })),
      };
      await this.enqueuePrintJob(
        event.branchId,
        g.printerId,
        g.documentType,
        printDoc,
        event.actorId || 'system',
        { orderId: order.id, orderNo: order.orderNo, type: g.documentType },
        event.eventId,
      );
    }
  }

  // Basılan fişi kalıcı kaydeder (reprint + audit için). receiptNo: orderNo-<tip><sıra>.
}

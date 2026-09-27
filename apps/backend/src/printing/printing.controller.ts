import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@ado/shared';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { PrintingService } from './printing.service';
import {
  createPrinterSchema,
  updatePrinterSchema,
  createPrintRouteSchema,
  printJobQuerySchema,
  type CreatePrinterDto,
  type UpdatePrinterDto,
  type CreatePrintRouteDto,
  type PrintJobQueryDto,
} from './dto/printing.schemas';

@Controller('printers')
export class PrintingController {
  constructor(private readonly printingService: PrintingService) {}

  @Post()
  @RequirePermissions(Permission.PrinterManage)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createPrinterSchema)) dto: CreatePrinterDto,
  ) {
    return this.printingService.createPrinter(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.PrinterManage)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePrinterSchema)) dto: UpdatePrinterDto,
  ) {
    return this.printingService.updatePrinter(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.PrinterManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.printingService.deletePrinter(user, id);
  }

  @Get()
  @RequirePermissions(Permission.PrinterManage)
  list(@CurrentUser() user: AuthUser) {
    return this.printingService.listPrinters(user);
  }

  // Kurulum ekrani: Windows'ta yuklu yazicilar (+ gelistirmede simulasyon yazicisi).
  @Get('discover')
  @RequirePermissions(Permission.PrinterManage)
  discover() {
    return this.printingService.discoverPrinters();
  }

  // Son 24 saatin fisleri; ?status=failed -> yazdirilamayanlar (masa ekrani uyarisi).
  @Get('jobs')
  @RequirePermissions(Permission.PrinterManage)
  listJobs(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(printJobQuerySchema)) query: PrintJobQueryDto,
  ) {
    return this.printingService.listJobs(user, query.status);
  }

  @Post('jobs/:id/retry')
  @RequirePermissions(Permission.PrinterManage)
  retryJob(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.printingService.retryJob(user, id);
  }

  @Delete('jobs/:id')
  @RequirePermissions(Permission.PrinterManage)
  dismissJob(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.printingService.dismissJob(user, id);
  }

  @Post('routes')
  @RequirePermissions(Permission.PrinterManage)
  createRoute(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createPrintRouteSchema)) dto: CreatePrintRouteDto,
  ) {
    return this.printingService.createRoute(user, dto);
  }

  @Delete('routes/:id')
  @RequirePermissions(Permission.PrinterManage)
  removeRoute(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.printingService.deleteRoute(user, id);
  }

  @Get('routes')
  @RequirePermissions(Permission.PrinterManage)
  listRoutes(@CurrentUser() user: AuthUser) {
    return this.printingService.listRoutes(user);
  }

  @Post('test-print/:id')
  @RequirePermissions(Permission.PrinterManage)
  async testPrint(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const jobPayload = { text: 'Yazıcı Sınama Sayfası\nDurum: Aktif\nBaşarılar!' };
    const jobId = await this.printingService.enqueuePrintJob(
      user.branchId,
      id,
      'test_page',
      jobPayload,
      user.userId,
    );
    return { success: true, jobId };
  }

  // Ödeme öncesi hesap/adisyon fişi (talep üzerine). Fiş 'bill' olarak kaydedilir.
  @Post('order/:id/bill')
  @RequirePermissions(Permission.OrderCreate)
  async printBill(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.printingService.printBill(user, id);
  }
}

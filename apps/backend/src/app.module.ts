import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { newId } from '@ado/shared';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { CloudModule } from './cloud/cloud.module';
import { TablesModule } from './tables/tables.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { AuditModule } from './common/audit/audit.module';
import { EventBusModule } from './common/events/event-bus.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { ResponseInterceptor } from './common/http/response.interceptor';
import { BackgroundWorkerModule } from './common/worker/worker.module';
import { ScheduleModule } from './common/schedule/schedule.module';
import { HealthModule } from './common/health/health.module';
import { FeatureFlagsModule } from './common/feature-flags/feature-flags.module';
import { PrintingModule } from './printing/printing.module';
import { BackupModule } from './backup/backup.module';
import { ReportsModule } from './reports/reports.module';
import { CashModule } from './cash/cash.module';
import { CustomerModule } from './customer/customer.module';
import { InventoryModule } from './inventory/inventory.module';
import { FinanceModule } from './finance/finance.module';
import { SettingsModule } from './settings/settings.module';
import { DevicesModule } from './devices/devices.module';
import { UsersModule } from './users/users.module';
import { SyncModule } from './sync/sync.module';
import { LicenseModule } from './license/license.module';
import { LicenseGuard } from './license/license.guard';
import { API_PREFIX } from './common/http/api-prefix';

const isProd = process.env.NODE_ENV === 'production';

// Tabletler bu uclara ~8 sn'de bir ping atar; her biri loglanirsa dosya sismez.
const UNLOGGED_PATHS = [`/${API_PREFIX}/health`, `/${API_PREFIX}/sync/health`];
const isUnloggedRequest = (req: IncomingMessage): boolean => {
  const path = (req.url ?? '').split('?')[0];
  return UNLOGGED_PATHS.includes(path ?? '');
};

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Paketli surumde log duz metin dosyaya yazilir: token/cookie asla loga girmez.
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          censor: '[redacted]',
        },
        autoLogging: { ignore: isUnloggedRequest },
        genReqId: (_req: IncomingMessage, res: ServerResponse): string => {
          const id = newId();
          res.setHeader('x-request-id', id);
          return id;
        },
        ...(isProd
          ? {}
          : {
              transport: {
                target: 'pino-pretty',
                options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' },
              },
            }),
      },
    }),
    ConfigModule,
    PrismaModule,
    EventBusModule,
    AuditModule,
    AuthModule,
    CatalogModule,
    TablesModule,
    OrdersModule,
    PaymentsModule,
    BackgroundWorkerModule,
    ScheduleModule,
    HealthModule,
    FeatureFlagsModule,
    PrintingModule,
    BackupModule,
    ReportsModule,
    CashModule,
    CustomerModule,
    InventoryModule,
    FinanceModule,
    SettingsModule,
    DevicesModule,
    UsersModule,
    SyncModule,
    LicenseModule,
    CloudModule,
  ],
  providers: [
    // Sira onemli: once kimlik (req.user'i doldurur), sonra izin denetimi.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Lisans en sonda: `license.enforce` ayari acilmadikca hicbir sey yapmaz.
    { provide: APP_GUARD, useClass: LicenseGuard },
  ],
})
export class AppModule {}

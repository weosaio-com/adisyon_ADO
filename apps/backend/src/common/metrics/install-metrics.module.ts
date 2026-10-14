import { Global, Module } from '@nestjs/common';
import { InstallMetricsService } from './install-metrics.service';

/** Global: saglik bilgisi saglayicilari (yedek, bulut yedegi) her modulden kaydolur. */
@Global()
@Module({
  providers: [InstallMetricsService],
  exports: [InstallMetricsService],
})
export class InstallMetricsModule {}

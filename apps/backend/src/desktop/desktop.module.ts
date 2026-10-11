import { Global, Module } from '@nestjs/common';
import { DesktopBridgeService } from './desktop-bridge.service';

/** Masaustu kabugu ile IPC (kapanis; ileride guncelleme onayi). */
@Global()
@Module({
  providers: [DesktopBridgeService],
  exports: [DesktopBridgeService],
})
export class DesktopModule {}

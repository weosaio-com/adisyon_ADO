import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';

@Module({
  // AuthService.verifyOwner: kurtarma anahtari gosterimi yonetici sifresi ister.
  imports: [AuthModule],
  providers: [BackupService],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}

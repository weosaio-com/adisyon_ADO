import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { RecoveryService } from './recovery.service';

/**
 * Kimlik/Yetki modulu. JwtModule secret'lari cagri basina (TokenService) verildigi
 * icin burada bos register edilir.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, TokenService, RecoveryService],
  // AuthService: yonetici sifre onayi (verifyOwner) baska modullerde de kullanilir.
  exports: [TokenService, AuthService],
})
export class AuthModule {}

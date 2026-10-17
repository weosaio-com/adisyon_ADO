import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../decorators/public.decorator';

/**
 * Canlilik denetimi: yalniz veritabani. Masaustu kabugu acilista, CI ve yayin duman testi bu
 * ucun 200 donmesini bekler. Disk dolulugu burada DENETLENMEZ (dolu disk yuzunden program hic
 * acilmiyordu); disk bilgisi /storage'da, temizlik oradan yapilir.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  @Public() // Electron denetcisi token'siz izler (ROADMAP: Health Check).
  @HealthCheck()
  check() {
    return this.health.check([
      async () => {
        try {
          await this.prismaService.$queryRawUnsafe('SELECT 1');
          return { database: { status: 'up' } };
        } catch {
          return { database: { status: 'down' } };
        }
      },
    ]);
  }
}

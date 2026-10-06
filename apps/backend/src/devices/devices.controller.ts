import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'express';
import { Permission } from '@ado/shared';
import { DevicesService } from './devices.service';
import { ZodValidationPipe } from '../common/http/zod-validation.pipe';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { API_PREFIX } from '../common/http/api-prefix';
import { resolveDataDir } from '../common/util/data-dir';
import { lanIPv4Addresses } from '../common/util/network';
import {
  registerDeviceSchema,
  trustDeviceSchema,
  type RegisterDeviceDto,
  type TrustDeviceDto,
} from './dto/devices.schemas';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  // Garsonun tablette gireceği sunucu adresi(leri). IP degisirse buradan gorulur.
  // HTTPS aciksa (API_TLS_PORT) onerilen adresler + tablete kurulacak sertifikanin adresi.
  @Get('server-info')
  serverInfo() {
    const port = Number(process.env.API_PORT) || 3001;
    const httpsPort = Number(process.env.API_TLS_PORT) || null;
    const addresses = lanIPv4Addresses();
    return {
      port,
      addresses,
      urls: addresses.map((a) => `http://${a}:${port}`),
      httpsPort,
      httpsUrls: httpsPort ? addresses.map((a) => `https://${a}:${httpsPort}`) : [],
      // Sertifika HTTP'den indirilir: tablet ona guvenmeden once HTTPS'e baglanamaz.
      caUrls: httpsPort
        ? addresses.map((a) => `http://${a}:${port}/${API_PREFIX}/devices/ca.crt`)
        : [],
    };
  }

  // Tablete bir kez kurulan yerel CA sertifikasi (acik anahtar; gizli degil). DER bicimi:
  // Android/iOS/Windows sertifika yukleyicileri .crt uzantili DER'i sorunsuz tanir.
  @Public()
  @Get('ca.crt')
  caCert(@Res() res: Response) {
    const path = join(resolveDataDir(), 'tls', 'ca.crt.pem');
    if (!existsSync(path)) {
      throw new NotFoundException({ code: 'TLS_DISABLED', message: 'HTTPS etkin değil.' });
    }
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="adisyon-pos-ca.crt"');
    res.send(new X509Certificate(readFileSync(path)).raw);
  }

  @Post()
  @RequirePermissions(Permission.SettingsManage)
  register(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(registerDeviceSchema)) dto: RegisterDeviceDto,
  ) {
    return this.devices.register(user, dto);
  }

  @Get()
  @RequirePermissions(Permission.SettingsManage)
  list(@CurrentUser() user: AuthUser) {
    return this.devices.list(user);
  }

  @Patch(':id/trust')
  @RequirePermissions(Permission.SettingsManage)
  setTrust(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(trustDeviceSchema)) dto: TrustDeviceDto,
  ) {
    return this.devices.setTrust(user, id, dto.isTrusted);
  }

  @Delete(':id')
  @RequirePermissions(Permission.SettingsManage)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.devices.remove(user, id);
  }
}

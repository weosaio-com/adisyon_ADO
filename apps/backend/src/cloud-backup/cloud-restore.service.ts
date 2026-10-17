import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { newId, type ByLicenseResponse, type CloudBackupMeta } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { resolveDataDir } from '../common/util/data-dir';
import { resolveInstallId } from '../common/util/install-id';
import { BackupService } from '../backup/backup.service';
import { CloudError, cloudRequest } from '../cloud/cloud.client';
import { normalizeCloudUrl } from '../cloud/cloud.snapshot';
import { downloadTimeoutMs, parseByLicenseResponse, resolveDownloadUrl } from './cloud-backup.plan';

type CloudBackupItem = ByLicenseResponse['backups'][number];

const UNREACHABLE = 'Buluta ulaşılamadı. İnternet bağlantısını kontrol edin.';

/** Bulut hatasi -> HTTP hatasi (kod ve Turkce mesaj buluttan gelir). */
function toHttpError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof CloudError) {
    const body = { code: err.code, message: err.status === 0 ? UNREACHABLE : err.message };
    if (err.status === 0 || err.status >= 500) return new BadGatewayException(body);
    if (err.status === 429) return new HttpException(body, 429);
    if (err.status === 403) return new ForbiddenException(body);
    if (err.status === 404) return new NotFoundException(body);
    if (err.status === 409) return new ConflictException(body);
    return new BadRequestException(body);
  }
  return new BadGatewayException({
    code: 'CLOUD_ERROR',
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Yeni bilgisayar, ilk kurulum (henuz kullanici yok): lisans anahtariyla buluttaki yedekler
 * listelenir, secilen yedek indirilir, yerel yedeklere alinir ve kurtarma anahtariyla geri
 * yuklenir (dosyadan geri yuklemeyle ayni yol; yeniden baslatmada uygulanir). Yalniz ana
 * bilgisayardan ve kullanici yokken (BackupService.setupBranchOrThrow). Bulut baglantisi burada
 * KURULMAZ: geri yuklenen veritabaninin lisansiyla sonra kendiliginden kurulur.
 */
@Injectable()
export class CloudRestoreService {
  private readonly logger = new Logger(CloudRestoreService.name);
  private restoring = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly backups: BackupService,
    private readonly config: AppConfigService,
  ) {}

  /** Programa gomulu bulut adresi (yeni kurulumda baglanti yok). */
  private cloudUrl(): string {
    try {
      if (this.config.cloudApiUrl) return normalizeCloudUrl(this.config.cloudApiUrl);
    } catch {
      // asagida
    }
    throw new ConflictException({
      code: 'CLOUD_NOT_CONFIGURED',
      message: 'Bu kurulumda bulut tanımlı değil.',
    });
  }

  private async byLicense(url: string, licenseKey: string): Promise<ByLicenseResponse> {
    let data: unknown;
    try {
      data = await cloudRequest<unknown>(url, '/api/pos/backups/by-license', {
        method: 'POST',
        json: { licenseKey, installId: resolveInstallId() },
      });
    } catch (err) {
      throw toHttpError(err);
    }
    const parsed = parseByLicenseResponse(data);
    if (!parsed) {
      throw new BadGatewayException({
        code: 'CLOUD_BAD_RESPONSE',
        message: 'Bulut beklenmeyen yanıt verdi.',
      });
    }
    return parsed;
  }

  async list(ip: string | undefined, licenseKey: string): Promise<{ backups: CloudBackupMeta[] }> {
    await this.backups.setupBranchOrThrow(ip);
    const { backups } = await this.byLicense(this.cloudUrl(), licenseKey);
    // Indirme adresleri kisa omurlu: geri yukleme istegi tazesini alir.
    return { backups: backups.map(({ downloadUrl: _url, expiresAt: _exp, ...meta }) => meta) };
  }

  async restore(
    ip: string | undefined,
    dto: { licenseKey: string; cloudBackupId: string; recoveryKey?: string | undefined },
  ) {
    const branchId = await this.backups.setupBranchOrThrow(ip);
    if (this.restoring) {
      throw new ConflictException({
        code: 'RESTORE_IN_PROGRESS',
        message: 'Geri yükleme zaten sürüyor.',
      });
    }
    this.restoring = true;
    try {
      const url = this.cloudUrl();
      const { backups } = await this.byLicense(url, dto.licenseKey);
      const item = backups.find((backup) => backup.id === dto.cloudBackupId);
      if (!item) {
        throw new NotFoundException({
          code: 'CLOUD_BACKUP_NOT_FOUND',
          message: 'Bu yedek bulutta bulunamadı. Listeyi yenileyin.',
        });
      }
      // Ayni yedek daha once indirildiyse (or. yanlis kurtarma anahtariyla denendi) tekrar inmez.
      const local =
        (await this.findImported(branchId, item)) ?? (await this.download(branchId, url, item));
      return await this.backups.restoreBackup({ branchId }, local.id, dto.recoveryKey);
    } finally {
      this.restoring = false;
    }
  }

  private async findImported(branchId: string, item: CloudBackupItem) {
    const found = await this.prisma.backup.findFirst({
      where: { branchId, type: 'imported', checksum: item.sha256, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return found && existsSync(found.path) ? found : null;
  }

  /**
   * Yedegi veri dizinindeki gecici dosyaya akitarak indirir (bellekte tutulmaz), boyutunu ve
   * SHA-256 ozetini buluttaki kayitla karsilastirir, sonra yerel yedeklere alir.
   */
  private async download(branchId: string, cloudUrl: string, item: CloudBackupItem) {
    const temp = join(resolveDataDir(), `cloud-restore-${newId()}.part`);
    try {
      let res: Response;
      try {
        res = await fetch(resolveDownloadUrl(cloudUrl, item.downloadUrl), {
          signal: AbortSignal.timeout(downloadTimeoutMs(item.sizeBytes)),
        });
      } catch {
        throw new BadGatewayException({ code: 'CLOUD_UNREACHABLE', message: UNREACHABLE });
      }
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        throw new BadGatewayException({
          code: body?.error?.code ?? 'CLOUD_DOWNLOAD_FAILED',
          message: body?.error?.message ?? `Yedek indirilemedi (HTTP ${res.status}).`,
        });
      }
      const hash = createHash('sha256');
      let size = 0;
      try {
        await pipeline(
          Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              size += chunk.length;
              hash.update(chunk);
              done(null, chunk);
            },
          }),
          createWriteStream(temp),
        );
      } catch {
        throw new BadGatewayException({
          code: 'CLOUD_DOWNLOAD_FAILED',
          message: 'Yedek indirilirken bağlantı kesildi. Tekrar deneyin.',
        });
      }
      if (size !== item.sizeBytes || hash.digest('hex') !== item.sha256) {
        throw new BadGatewayException({
          code: 'CLOUD_BACKUP_CORRUPT',
          message: 'İndirilen yedek bozuk (özet uyuşmuyor). Tekrar deneyin.',
        });
      }
      const imported = await this.backups.importBackup({ branchId }, createReadStream(temp));
      this.logger.log(`Buluttaki yedek indirildi: ${item.id} -> ${imported.id} (${size} bayt)`);
      return imported;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

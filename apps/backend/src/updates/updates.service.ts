import { ConflictException, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { newId, UpdateStatus } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../config/app-config.service';
import { BackupService } from '../backup/backup.service';
import { isLocalRequest } from '../common/http/local-request';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { DesktopBridgeService, type DesktopUpdateStatus } from '../desktop/desktop-bridge.service';
import { approvalOutcome, updateBlockers } from './updates.logic';

/**
 * Otomatik guncelleme (UPDATE_SYSTEM.md): denetim ve indirme masaustu kabugunda, imzali bildirimle
 * (apps/desktop/updater.mjs). Backend kabugun bildirdigi durumu sunar ve kurulum onayini verir:
 * yetki (`update.manage`), kasa bilgisayari, acik adisyon ve acik kasa yok; once sifreli yedek, sonra
 * gecmis kaydi ve denetim kaydi, en son kabuga "kur" komutu. Program yeni surumle acilinca kayit
 * "kuruldu" ya da "kurulamadi" olur.
 */
@Injectable()
export class UpdatesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UpdatesService.name);
  private desktop: DesktopUpdateStatus | null = null;
  private approving = false;

  constructor(
    private readonly bridge: DesktopBridgeService,
    private readonly prisma: PrismaService,
    private readonly backups: BackupService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {
    bridge.onMessage((message) => {
      if (message.type === 'update-status') this.desktop = message;
    });
  }

  async onApplicationBootstrap() {
    await this.settleApprovals().catch((err: unknown) => {
      this.logger.error(`Guncelleme gecmisi guncellenemedi: ${String(err)}`);
    });
  }

  private get available(): boolean {
    return this.bridge.attached && this.desktop !== null && this.desktop.state !== 'disabled';
  }

  private async blockers(branchId: string, ip: string | undefined) {
    const [openOrders, openCash] = await Promise.all([
      this.prisma.order.count({
        where: { branchId, status: { in: ['open', 'held'] }, deletedAt: null },
      }),
      this.prisma.cashSession.count({ where: { branchId, status: 'open', deletedAt: null } }),
    ]);
    return updateBlockers({ local: isLocalRequest(ip), openOrders, cashOpen: openCash > 0 });
  }

  async status(user: AuthUser, ip: string | undefined) {
    const desktop = this.desktop;
    const blockers = this.available ? await this.blockers(user.branchId, ip) : [];
    const last = await this.prisma.updateHistory.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return {
      /** Masaustu programinda ve guncelleme anahtari tanimliysa (kart gorunur). */
      available: this.available,
      currentVersion: this.config.appVersion || desktop?.currentVersion || null,
      channel: desktop?.channel ?? null,
      state: desktop?.state ?? 'disabled',
      version: desktop?.version ?? null,
      notes: desktop?.notes ?? null,
      progress: desktop?.progress ?? null,
      error: desktop?.error ?? null,
      checkedAt: desktop?.checkedAt ?? null,
      blockers,
      canInstall: this.available && desktop?.state === 'ready' && blockers.length === 0,
      lastUpdate: last
        ? {
            fromVersion: last.fromVersion,
            toVersion: last.toVersion,
            status: last.status,
            appliedAt: last.appliedAt,
            error: last.error,
            createdAt: last.createdAt,
          }
        : null,
    };
  }

  async check(user: AuthUser, ip: string | undefined) {
    if (!this.available || !this.bridge.send({ type: 'update-check' })) {
      throw new ConflictException({
        code: 'UPDATE_NOT_AVAILABLE',
        message: 'Bu kurulumda otomatik güncelleme yok.',
      });
    }
    return this.status(user, ip);
  }

  async approve(user: AuthUser, ip: string | undefined, version: string) {
    const desktop = this.desktop;
    if (!this.available || !desktop) {
      throw new ConflictException({
        code: 'UPDATE_NOT_AVAILABLE',
        message: 'Bu kurulumda otomatik güncelleme yok.',
      });
    }
    if (desktop.state !== 'ready' || desktop.version !== version) {
      throw new ConflictException({
        code: 'UPDATE_NOT_READY',
        message: 'Bu sürüm kurulmaya hazır değil.',
      });
    }
    if (this.approving) {
      throw new ConflictException({ code: 'UPDATE_IN_PROGRESS', message: 'Kurulum başladı.' });
    }
    this.approving = true;
    try {
      const blockers = await this.blockers(user.branchId, ip);
      if (blockers.length > 0) {
        throw new ConflictException({
          code: 'UPDATE_BLOCKED',
          message: blockers.map((blocker) => blocker.message).join(' '),
          details: blockers,
        });
      }
      // Geri donus icin: kurulumdan once sifreli yedek.
      const backup = await this.backups.createBackup(
        { branchId: user.branchId, userId: user.userId },
        'pre_update',
      );
      const fromVersion = this.config.appVersion || desktop.currentVersion;
      const history = await this.prisma.updateHistory.create({
        data: {
          id: newId(),
          fromVersion,
          toVersion: version,
          channel: desktop.channel,
          status: UpdateStatus.Ready,
          backupId: backup.id,
          initiatedBy: user.userId,
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
      });
      await this.audit.record({
        branchId: user.branchId,
        action: 'update.approve',
        entityType: 'update',
        entityId: history.id,
        userId: user.userId,
        newValue: {
          fromVersion,
          toVersion: version,
          channel: desktop.channel,
          backupId: backup.id,
        },
        ...(user.deviceId ? { deviceId: user.deviceId } : {}),
      });
      if (!this.bridge.send({ type: 'update-install', version })) {
        await this.prisma.updateHistory.update({
          where: { id: history.id },
          data: { status: UpdateStatus.Failed, error: 'Masaüstü programına ulaşılamadı.' },
        });
        throw new ConflictException({
          code: 'UPDATE_NOT_AVAILABLE',
          message: 'Masaüstü programına ulaşılamadı.',
        });
      }
      this.desktop = { ...desktop, state: 'installing' };
      return this.status(user, ip);
    } finally {
      this.approving = false;
    }
  }

  /** Acilista onaylanmis kurulumlarin sonucu yazilir (surum degistiyse kuruldu). */
  private async settleApprovals() {
    const current = this.config.appVersion;
    if (!current) return; // gelistirme: surum bilinmiyor
    const pending = await this.prisma.updateHistory.findMany({
      where: { status: UpdateStatus.Ready, deletedAt: null },
    });
    for (const row of pending) {
      const outcome = approvalOutcome(row.toVersion, current);
      await this.prisma.updateHistory.update({
        where: { id: row.id },
        data:
          outcome === 'applied'
            ? { status: UpdateStatus.Applied, appliedAt: new Date() }
            : {
                status: UpdateStatus.Failed,
                error: `Kurulum tamamlanmadı; program ${current} ile açıldı.`,
              },
      });
      this.logger.log(`Guncelleme ${row.fromVersion} -> ${row.toVersion}: ${outcome}`);
    }
  }
}

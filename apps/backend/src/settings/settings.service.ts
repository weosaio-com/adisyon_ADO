import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { newId } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';

// Fis basligi. Bos adres/telefon basilmaz.
export const businessInfoSchema = z.object({
  name: z.string().trim().min(1).max(60),
  address: z.string().trim().max(160).nullish(),
  phone: z.string().trim().max(30).nullish(),
});
export type BusinessInfoDto = z.infer<typeof businessInfoSchema>;

/** Uygulama ayarlari (branch bazli key-value, value = JSON) + isletme bilgileri (Branch). */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getBusiness(user: AuthUser) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: user.branchId },
      select: { name: true, address: true, phone: true },
    });
    if (!branch)
      throw new NotFoundException({ code: 'BRANCH_NOT_FOUND', message: 'Şube bulunamadı.' });
    return branch;
  }

  async setBusiness(user: AuthUser, dto: BusinessInfoDto) {
    const before = await this.getBusiness(user);
    const after = await this.prisma.branch.update({
      where: { id: user.branchId },
      data: {
        name: dto.name,
        address: dto.address || null,
        phone: dto.phone || null,
        version: { increment: 1 },
      },
      select: { name: true, address: true, phone: true },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'settings.business',
      entityType: 'branch',
      entityId: user.branchId,
      userId: user.userId,
      oldValue: before,
      newValue: after,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return after;
  }

  async list(user: AuthUser) {
    const rows = await this.prisma.applicationSetting.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      orderBy: { key: 'asc' },
    });
    return rows
      .filter((row) => row.key === 'backup.cloudDir' || row.key === 'backup.autoDaily')
      .map((r) => ({ key: r.key, value: JSON.parse(r.value), updatedAt: r.updatedAt }));
  }

  async set(user: AuthUser, key: string, value: unknown) {
    const valid =
      (key === 'backup.cloudDir' && typeof value === 'string') ||
      (key === 'backup.autoDaily' && typeof value === 'boolean');
    if (!valid) {
      throw new BadRequestException({
        code: 'SETTING_NOT_ALLOWED',
        message: 'Bilinmeyen veya gecersiz ayar.',
      });
    }
    const serialized = JSON.stringify(value ?? null);
    const existing = await this.prisma.applicationSetting.findUnique({
      where: { branchId_key: { branchId: user.branchId, key } },
    });
    if (existing) {
      return this.prisma.applicationSetting.update({
        where: { id: existing.id },
        data: {
          value: serialized,
          updatedBy: user.userId,
          version: { increment: 1 },
          syncState: 'pending',
        },
      });
    }
    return this.prisma.applicationSetting.create({
      data: {
        id: newId(),
        branchId: user.branchId,
        key,
        value: serialized,
        updatedBy: user.userId,
        deviceId: user.deviceId ?? null,
      },
    });
  }
}

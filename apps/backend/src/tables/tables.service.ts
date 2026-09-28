import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  newId,
  createDomainEvent,
  DomainEventName,
  encodeTableCode,
  TABLE_CODE_BYTES,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EventBusService } from '../common/events/event-bus.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type {
  CreateHallDto,
  UpdateHallDto,
  CreateTableDto,
  UpdateTableDto,
  TableQueryDto,
} from './dto/tables.schemas';

/**
 * Masa/Salon: Salon (Hall) + Masa (Table) tanimi ve kat plani (posX/posY).
 * Ortak kurallar: branchId izole, soft-delete, her mutasyonda version++ +
 * syncState='pending' (Faz 2 outbox) + audit kaydi.
 *
 * KAPSAM DISI (Siparis modulunde): durum gecisi (occupied/reserved), birlestirme/
 * tasima (merge/move), canli WebSocket masa katmani. Burada `status` degistirilmez.
 *
 * QR menu: her masanin tahmin edilemez bir `publicCode`'u vardir (QR'daki `/m/<kod>`).
 * Yeni masada uretilir, eski masalara acilista verilir, istenince yenilenir.
 */
@Injectable()
export class TablesService implements OnModuleInit {
  private readonly logger = new Logger(TablesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  // Migration sonrasi kodu olmayan masalara kod ver (rastgele base32 SQL'de uretilemez).
  async onModuleInit(): Promise<void> {
    const missing = await this.prisma.table.findMany({
      where: { publicCode: null, deletedAt: null },
      select: { id: true },
    });
    for (const { id } of missing) {
      await this.prisma.table.update({ where: { id }, data: { publicCode: newPublicCode() } });
    }
    if (missing.length) this.logger.log(`${missing.length} masaya QR kodu verildi`);
  }

  private provenance(user: AuthUser): { deviceId?: string } {
    return user.deviceId ? { deviceId: user.deviceId } : {};
  }

  private async publishTableEvent(
    user: AuthUser,
    name: (typeof DomainEventName)[keyof typeof DomainEventName],
    table: { id: string; hallId: string; name: string },
  ): Promise<void> {
    await this.events.publish(
      createDomainEvent(
        name,
        { tableId: table.id, hallId: table.hallId, name: table.name },
        {
          branchId: user.branchId,
          actorId: user.userId,
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
      ),
    );
  }

  // ===========================================================================
  // Salon (Hall)
  // ===========================================================================
  listHalls(user: AuthUser) {
    return this.prisma.hall.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  getHall(user: AuthUser, id: string) {
    return this.hallOrThrow(user.branchId, id);
  }

  async createHall(user: AuthUser, dto: CreateHallDto) {
    const id = newId();
    const created = await this.prisma.hall.create({
      data: {
        id,
        branchId: user.branchId,
        name: dto.name,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
        ...this.provenance(user),
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'hall.create',
      entityType: 'hall',
      entityId: id,
      userId: user.userId,
      newValue: created,
      ...this.provenance(user),
    });
    return created;
  }

  async updateHall(user: AuthUser, id: string, dto: UpdateHallDto) {
    const before = await this.hallOrThrow(user.branchId, id);
    const after = await this.prisma.hall.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'hall.update',
      entityType: 'hall',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      newValue: after,
      ...this.provenance(user),
    });
    return after;
  }

  async deleteHall(user: AuthUser, id: string) {
    const before = await this.hallOrThrow(user.branchId, id);
    const tableCount = await this.prisma.table.count({
      where: { branchId: user.branchId, hallId: id, deletedAt: null },
    });
    if (tableCount > 0) {
      throw new ConflictException({
        code: 'HALL_NOT_EMPTY',
        message: 'Masa iceren salon silinemez.',
      });
    }
    const after = await this.prisma.hall.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'hall.delete',
      entityType: 'hall',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      ...this.provenance(user),
    });
    return after;
  }

  // ===========================================================================
  // Masa (Table)
  // ===========================================================================
  listTables(user: AuthUser, query: TableQueryDto) {
    return this.prisma.table.findMany({
      where: {
        branchId: user.branchId,
        deletedAt: null,
        ...(query.hallId ? { hallId: query.hallId } : {}),
        ...(query.active !== undefined ? { isActive: query.active } : {}),
      },
      orderBy: [{ name: 'asc' }],
    });
  }

  getTable(user: AuthUser, id: string) {
    return this.tableOrThrow(user.branchId, id);
  }

  async createTable(user: AuthUser, dto: CreateTableDto) {
    await this.hallOrThrow(user.branchId, dto.hallId);

    const id = newId();
    const created = await this.prisma.table.create({
      data: {
        id,
        branchId: user.branchId,
        hallId: dto.hallId,
        name: dto.name,
        seats: dto.seats ?? 4,
        posX: dto.posX ?? null,
        posY: dto.posY ?? null,
        isActive: dto.isActive ?? true,
        publicCode: newPublicCode(),
        // status varsayilan 'empty' (semada). Durum gecisi Siparis modulunde.
        ...this.provenance(user),
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'table.create',
      entityType: 'table',
      entityId: id,
      userId: user.userId,
      newValue: created,
      ...this.provenance(user),
    });
    await this.publishTableEvent(user, DomainEventName.TableCreated, created);
    return created;
  }

  async updateTable(user: AuthUser, id: string, dto: UpdateTableDto) {
    const before = await this.tableOrThrow(user.branchId, id);
    if (dto.hallId !== undefined) await this.hallOrThrow(user.branchId, dto.hallId);

    const after = await this.prisma.table.update({
      where: { id },
      data: {
        ...(dto.hallId !== undefined ? { hallId: dto.hallId } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.seats !== undefined ? { seats: dto.seats } : {}),
        ...(dto.posX !== undefined ? { posX: dto.posX } : {}),
        ...(dto.posY !== undefined ? { posY: dto.posY } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'table.update',
      entityType: 'table',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      newValue: after,
      ...this.provenance(user),
    });
    await this.publishTableEvent(user, DomainEventName.TableUpdated, after);
    return after;
  }

  async deleteTable(user: AuthUser, id: string) {
    const before = await this.tableOrThrow(user.branchId, id);
    // Canli siparisi olan masa silinemez (siparisi oksuz birakmamak icin).
    // Not: Siparis modulu gelince "yalnizca acik siparis" olarak daraltilacak.
    const orderCount = await this.prisma.order.count({
      where: { branchId: user.branchId, tableId: id, deletedAt: null },
    });
    if (orderCount > 0) {
      throw new ConflictException({
        code: 'TABLE_HAS_ORDERS',
        message: 'Siparisi olan masa silinemez.',
      });
    }
    const after = await this.prisma.table.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'table.delete',
      entityType: 'table',
      entityId: id,
      userId: user.userId,
      oldValue: before,
      ...this.provenance(user),
    });
    await this.publishTableEvent(user, DomainEventName.TableDeleted, before);
    return after;
  }

  /** QR kodunu yeniler: masadaki eski QR artik menuyu acmaz (yeniden basilmali). */
  async rotatePublicCode(user: AuthUser, id: string) {
    const before = await this.tableOrThrow(user.branchId, id);
    const after = await this.prisma.table.update({
      where: { id },
      data: { publicCode: newPublicCode(), version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'table.public_code.rotate',
      entityType: 'table',
      entityId: id,
      userId: user.userId,
      oldValue: { publicCode: before.publicCode },
      newValue: { publicCode: after.publicCode },
      ...this.provenance(user),
    });
    await this.publishTableEvent(user, DomainEventName.TableUpdated, after);
    return after;
  }

  // ===========================================================================
  // Yardimcilar
  // ===========================================================================
  private async hallOrThrow(branchId: string, id: string) {
    const row = await this.prisma.hall.findFirst({
      where: { id, branchId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'HALL_NOT_FOUND', message: 'Salon bulunamadi.' });
    }
    return row;
  }

  private async tableOrThrow(branchId: string, id: string) {
    const row = await this.prisma.table.findFirst({
      where: { id, branchId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'TABLE_NOT_FOUND', message: 'Masa bulunamadi.' });
    }
    return row;
  }
}

/** 80 bit rastgele masa kodu (16 karakter base32). Cakisma olasiligi ihmal edilebilir. */
function newPublicCode(): string {
  return encodeTableCode(randomBytes(TABLE_CODE_BYTES));
}

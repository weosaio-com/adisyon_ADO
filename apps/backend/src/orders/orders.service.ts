import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  newId,
  createDomainEvent,
  DomainEventName,
  OrderStatus,
  OrderType,
  OrderItemStatus,
  PaymentDirection,
  TableStatus,
  Permission,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EventBusService } from '../common/events/event-bus.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { computeItemTotals, applyOrderDiscounts } from './orders.calc';
import type {
  OpenOrderDto,
  AddItemDto,
  UpdateItemDto,
  ItemNoteDto,
  VoidItemDto,
  CancelOrderDto,
  OrderQueryDto,
  ApplyDiscountDto,
  SplitOrderDto,
} from './dto/orders.schemas';

// Gun sonu saati (vars. 06:00 — CONVENTIONS.md). orderNo gunluk sirasi buna gore.
// Not: ileride ApplicationSetting'ten okunacak (Ayarlar modulu).
const DAY_END_HOUR = 6;

/**
 * Siparis/Adisyon cekirdegi (PR1): adisyon ac, kalem ekle/guncelle/sil/void,
 * toplam hesabi, adisyon iptal. branchId izole, soft-delete, version++,
 * syncState, mutasyonlarda audit + domain event. clientOpId ile idempotent (offline).
 *
 * Fiyat/vergi/ad kalem eklenirken SNAPSHOT alinir -> urun sonradan degisse adisyon sabit.
 * KDV fiyata DAHIL: grandTotal = subtotal - discountTotal; taxTotal bilgi amacli (icerideki KDV).
 *
 * KAPSAM DISI (PR2): mutfaga gonder, adisyon-seviyesi indirim, held, canli WS masa katmani.
 * Odeme/kapatma ayri modul.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  private provenance(user: AuthUser): { deviceId?: string } {
    return user.deviceId ? { deviceId: user.deviceId } : {};
  }

  // ===========================================================================
  // Adisyon
  // ===========================================================================
  async openOrder(user: AuthUser, dto: OpenOrderDto) {
    // Idempotency: ayni clientOpId ile tekrar gelirse mevcut adisyonu don.
    if (dto.clientOpId) {
      const existing = await this.prisma.order.findUnique({
        where: { clientOpId: dto.clientOpId },
      });
      if (existing) {
        if (existing.branchId !== user.branchId) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Bu islem anahtari baska bir subede kullanilmis.',
          });
        }
        return this.orderWithItems(existing.id);
      }
    }

    await this.requireOpenCashSession(user.branchId);

    if (dto.tableId) {
      await this.tableOrThrow(user.branchId, dto.tableId);
      const open = await this.prisma.order.findFirst({
        where: {
          branchId: user.branchId,
          tableId: dto.tableId,
          status: { in: [OrderStatus.Open, OrderStatus.Held] },
          deletedAt: null,
        },
      });
      if (open) {
        throw new ConflictException({
          code: 'TABLE_HAS_OPEN_ORDER',
          message: 'Masada zaten acik adisyon var.',
        });
      }
    }

    const id = newId();
    const created = await this.prisma.$transaction(async (tx) => {
      await this.requireOpenCashSession(user.branchId, tx);
      const orderNo = await this.generateOrderNo(tx, user.branchId);
      const order = await tx.order.create({
        data: {
          id,
          branchId: user.branchId,
          tableId: dto.tableId ?? null,
          type: dto.type ?? OrderType.DineIn,
          orderNo,
          status: OrderStatus.Open,
          openedBy: user.userId,
          openedAt: new Date(),
          guestCount: dto.guestCount ?? 1,
          note: dto.note ?? null,
          ...(dto.clientOpId ? { clientOpId: dto.clientOpId } : {}),
          ...this.provenance(user),
        },
      });
      if (dto.tableId) {
        await tx.table.update({
          where: { id: dto.tableId },
          data: { status: TableStatus.Occupied, version: { increment: 1 }, syncState: 'pending' },
        });
      }
      return order;
    });

    await this.audit.record({
      branchId: user.branchId,
      action: 'order.open',
      entityType: 'order',
      entityId: id,
      userId: user.userId,
      newValue: created,
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderCreated, created);
    return this.orderWithItems(id);
  }

  listOrders(user: AuthUser, query: OrderQueryDto) {
    return this.prisma.order.findMany({
      where: {
        branchId: user.branchId,
        deletedAt: null,
        ...(query.tableId ? { tableId: query.tableId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.open ? { status: OrderStatus.Open } : {}),
      },
      include: { items: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
      orderBy: { openedAt: 'desc' },
    });
  }

  getOrder(user: AuthUser, id: string) {
    return this.orderWithItemsOrThrow(user.branchId, id);
  }

  async cancelOrder(user: AuthUser, id: string, dto: CancelOrderDto) {
    const order = await this.orderOrThrow(user.branchId, id);
    if (order.status !== OrderStatus.Open && order.status !== OrderStatus.Held) {
      throw new ConflictException({
        code: 'ORDER_NOT_CANCELABLE',
        message: 'Yalnizca acik/bekleyen adisyon iptal edilebilir.',
      });
    }
    // Odemesi alinmis adisyon iptal edilemez: para kayitlarda bosta kalir.
    if ((await this.netPaid(id)) > 0) {
      throw new ConflictException({
        code: 'ORDER_HAS_PAYMENTS',
        message: 'Odeme alinmis adisyon iptal edilemez; once odemeyi iade edin.',
      });
    }
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: OrderStatus.Cancelled,
        closedBy: user.userId,
        closedAt: new Date(),
        note: dto.reason ?? order.note,
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
    if (order.tableId) await this.freeTableIfNoOpenOrder(user.branchId, order.tableId);

    await this.audit.record({
      branchId: user.branchId,
      action: 'order.cancel',
      entityType: 'order',
      entityId: id,
      userId: user.userId,
      oldValue: order,
      newValue: updated,
      ...(dto.reason ? { reason: dto.reason } : {}),
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(id);
  }

  // ===========================================================================
  // Kalem
  // ===========================================================================
  async addItem(user: AuthUser, orderId: string, dto: AddItemDto) {
    await this.orderOpenOrThrow(user.branchId, orderId);

    if (dto.clientOpId) {
      const existing = await this.prisma.orderItem.findUnique({
        where: { clientOpId: dto.clientOpId },
        include: { order: { select: { branchId: true } } },
      });
      if (existing) {
        if (existing.orderId !== orderId || existing.order.branchId !== user.branchId) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Bu islem anahtari baska bir kalemde kullanilmis.',
          });
        }
        return this.orderWithItems(orderId);
      }
    }

    const product = await this.productForOrder(user.branchId, dto.productId);
    const gross = Math.round((product.salePrice * dto.quantity) / 1000);
    const lineTotal = gross; // lineDiscount 0 (satir indirimi PR2)

    const itemId = newId();
    const { item, updated } = await this.prisma.$transaction(async (tx) => {
      const item = await tx.orderItem.create({
        data: {
          id: itemId,
          orderId,
          productId: product.id,
          productNameSnapshot: product.name,
          unitPrice: product.salePrice,
          quantity: dto.quantity,
          taxRatePermille: product.tax.ratePermille,
          lineDiscount: 0,
          lineTotal,
          status: OrderItemStatus.Pending,
          addedBy: user.userId,
          ...(dto.clientOpId ? { clientOpId: dto.clientOpId } : {}),
          ...this.provenance(user),
        },
      });
      if (dto.note) {
        await tx.orderItemNote.create({
          data: {
            id: newId(),
            orderItemId: itemId,
            note: dto.note,
            type: 'waiter',
            createdBy: user.userId,
            ...this.provenance(user),
          },
        });
      }
      return { item, updated: await this.recompute(orderId, tx) };
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.item.add',
      entityType: 'order_item',
      entityId: itemId,
      userId: user.userId,
      newValue: item,
      ...this.provenance(user),
    });
    await this.publishOrderItemEvent(user, DomainEventName.OrderItemAdded, {
      orderId,
      orderItemId: itemId,
      productId: product.id,
      quantity: dto.quantity,
      lineTotal,
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  async updateItem(user: AuthUser, orderId: string, itemId: string, dto: UpdateItemDto) {
    const order = await this.orderOpenOrThrow(user.branchId, orderId);
    const item = await this.itemOrThrow(orderId, itemId);
    this.assertItemEditable(item);

    const gross = Math.round((item.unitPrice * dto.quantity) / 1000);
    const lineTotal = gross - item.lineDiscount;
    await this.assertNotBelowPaid(
      orderId,
      order.grandTotal,
      order.grandTotal - (item.lineTotal - lineTotal),
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: {
          quantity: dto.quantity,
          lineTotal,
          version: { increment: 1 },
          syncState: 'pending',
        },
      });
      return this.recompute(orderId, tx);
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.item.update',
      entityType: 'order_item',
      entityId: itemId,
      userId: user.userId,
      oldValue: item,
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  async removeItem(user: AuthUser, orderId: string, itemId: string) {
    const order = await this.orderOpenOrThrow(user.branchId, orderId);
    const item = await this.itemOrThrow(orderId, itemId);
    this.assertItemEditable(item);

    await this.assertNotBelowPaid(orderId, order.grandTotal, order.grandTotal - item.lineTotal);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
      });
      return this.recompute(orderId, tx);
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.item.remove',
      entityType: 'order_item',
      entityId: itemId,
      userId: user.userId,
      oldValue: item,
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // Tek garson notu: yoksa olustur, varsa guncelle, bos gelirse sil. Gonderilmis kaleme
  // not eklenmez (mutfak fisi basildi; degisiklik icin void + yeni kalem).
  async setItemNote(user: AuthUser, orderId: string, itemId: string, dto: ItemNoteDto) {
    const order = await this.orderOpenOrThrow(user.branchId, orderId);
    const item = await this.itemOrThrow(orderId, itemId);
    this.assertItemEditable(item);

    const text = dto.note?.trim() ?? '';
    const existing = await this.prisma.orderItemNote.findFirst({
      where: { orderItemId: itemId, type: 'waiter', deletedAt: null },
    });
    if (existing && !text) {
      await this.prisma.orderItemNote.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
      });
    } else if (existing) {
      await this.prisma.orderItemNote.update({
        where: { id: existing.id },
        data: { note: text, version: { increment: 1 }, syncState: 'pending' },
      });
    } else if (text) {
      await this.prisma.orderItemNote.create({
        data: {
          id: newId(),
          orderItemId: itemId,
          note: text,
          type: 'waiter',
          createdBy: user.userId,
          ...this.provenance(user),
        },
      });
    }
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.item.note',
      entityType: 'order_item',
      entityId: itemId,
      userId: user.userId,
      oldValue: existing?.note ?? null,
      newValue: text || null,
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, order);
    return this.orderWithItems(orderId);
  }

  // Yanlislikla acilan masa: aktif kalemi ve odemesi olmayan adisyon kapatilir (masa bosalir).
  async discardEmptyOrder(user: AuthUser, id: string) {
    await this.orderOrThrow(user.branchId, id);
    const activeItems = await this.prisma.orderItem.count({
      where: { orderId: id, deletedAt: null, status: { not: OrderItemStatus.Cancelled } },
    });
    if (activeItems > 0) {
      throw new ConflictException({
        code: 'ORDER_NOT_EMPTY',
        message: 'Adisyonda ürün var; dolu adisyonu yalnızca yönetici iptal edebilir.',
      });
    }
    return this.cancelOrder(user, id, { reason: 'Boş adisyon kapatıldı' });
  }

  // Void: gonderilmis/onaylanmis kalemi iptal eder (Owner). Satir kalir, status=cancelled.
  async voidItem(user: AuthUser, orderId: string, itemId: string, dto: VoidItemDto) {
    const order = await this.orderOpenOrThrow(user.branchId, orderId);
    const item = await this.itemOrThrow(orderId, itemId);
    if (item.status === OrderItemStatus.Cancelled) {
      throw new ConflictException({
        code: 'ITEM_ALREADY_VOID',
        message: 'Kalem zaten iptal edilmis.',
      });
    }
    await this.assertNotBelowPaid(orderId, order.grandTotal, order.grandTotal - item.lineTotal);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: itemId },
        data: {
          status: OrderItemStatus.Cancelled,
          voidedBy: user.userId,
          voidReason: dto.reason ?? null,
          version: { increment: 1 },
          syncState: 'pending',
        },
      });
      const updated = await this.recompute(orderId, tx);
      await this.events.publishDurable(
        tx,
        createDomainEvent(
          DomainEventName.OrderItemVoided,
          {
            orderId,
            orderItemId: itemId,
            productId: item.productId,
            quantity: item.quantity,
            lineTotal: item.lineTotal,
          },
          {
            branchId: user.branchId,
            actorId: user.userId,
            ...(user.deviceId ? { deviceId: user.deviceId } : {}),
          },
        ),
      );
      return updated;
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.item.void',
      entityType: 'order_item',
      entityId: itemId,
      userId: user.userId,
      oldValue: item,
      ...(dto.reason ? { reason: dto.reason } : {}),
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // ===========================================================================
  // Beklet / tekrar ac + masa tasi
  // ===========================================================================
  async holdOrder(user: AuthUser, orderId: string) {
    const order = await this.orderOpenOrThrow(user.branchId, orderId);
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.Held, version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.hold',
      entityType: 'order',
      entityId: orderId,
      userId: user.userId,
      oldValue: order,
      newValue: updated,
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  async resumeOrder(user: AuthUser, orderId: string) {
    const order = await this.orderOrThrow(user.branchId, orderId);
    if (order.status !== OrderStatus.Held) {
      throw new ConflictException({
        code: 'ORDER_NOT_HELD',
        message: 'Yalnizca bekleyen adisyon tekrar acilabilir.',
      });
    }
    await this.requireOpenCashSession(user.branchId);
    // Masasi baska acik adisyona kapildiysa engelle.
    if (order.tableId) {
      const clash = await this.prisma.order.findFirst({
        where: {
          branchId: user.branchId,
          tableId: order.tableId,
          status: { in: [OrderStatus.Open, OrderStatus.Held] },
          id: { not: order.id },
          deletedAt: null,
        },
      });
      if (clash) {
        throw new ConflictException({
          code: 'TABLE_HAS_OPEN_ORDER',
          message: 'Masada acik adisyon var; once onu kapatin.',
        });
      }
    }
    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.Open, version: { increment: 1 }, syncState: 'pending' },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.resume',
      entityType: 'order',
      entityId: orderId,
      userId: user.userId,
      oldValue: order,
      newValue: updated,
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // Adisyonu baska (bos) masaya tasir. Eski masa serbest kalirsa bosaltilir.
  async moveTable(user: AuthUser, orderId: string, targetTableId: string) {
    const order = await this.orderOpenOrThrow(user.branchId, orderId);
    if (order.tableId === targetTableId) return this.orderWithItems(orderId);
    await this.tableOrThrow(user.branchId, targetTableId);
    const occupied = await this.prisma.order.findFirst({
      where: {
        branchId: user.branchId,
        tableId: targetTableId,
        status: { in: [OrderStatus.Open, OrderStatus.Held] },
        deletedAt: null,
      },
    });
    if (occupied) {
      throw new ConflictException({
        code: 'TABLE_HAS_OPEN_ORDER',
        message: 'Hedef masada acik adisyon var.',
      });
    }
    const oldTableId = order.tableId;
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { tableId: targetTableId, version: { increment: 1 }, syncState: 'pending' },
      });
      await tx.table.update({
        where: { id: targetTableId },
        data: { status: TableStatus.Occupied, version: { increment: 1 }, syncState: 'pending' },
      });
    });
    if (oldTableId) await this.freeTableIfNoOpenOrder(user.branchId, oldTableId);

    await this.audit.record({
      branchId: user.branchId,
      action: 'order.move_table',
      entityType: 'order',
      entityId: orderId,
      userId: user.userId,
      oldValue: { tableId: oldTableId },
      newValue: { tableId: targetTableId },
      ...this.provenance(user),
    });
    const updated = await this.orderOrThrow(user.branchId, orderId);
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // ===========================================================================
  // Adisyon birlestir / bol (merge / split)
  // ===========================================================================
  // Iki acik adisyonu birlestirir: kaynagin kalem + adisyon-indirimleri hedefe
  // tasinir, kaynak adisyon iptal (Cancelled) edilir, masasi serbest kalir.
  // Gelir korunur: kalemler ve indirim tutarlari aynen tasinir, hedefte yeniden
  // hesaplanir. Her indirim <= kendi ara toplami oldugundan birlesik toplamda da
  // toplam indirim <= birlesik ara toplam -> grandTotal negatif olmaz.
  async mergeOrders(user: AuthUser, targetOrderId: string, sourceOrderId: string) {
    if (targetOrderId === sourceOrderId) {
      throw new BadRequestException({
        code: 'MERGE_SAME_ORDER',
        message: 'Adisyon kendisiyle birlestirilemez.',
      });
    }
    const target = await this.orderOpenOrThrow(user.branchId, targetOrderId);
    const source = await this.orderOpenOrThrow(user.branchId, sourceOrderId);

    // Kaynagin odemeleri hedefe TASINMAZ; odemeli kaynak birlesirse musteri
    // ayni tutari ikinci kez oder -> engelle.
    if ((await this.netPaid(sourceOrderId)) > 0) {
      throw new ConflictException({
        code: 'MERGE_SOURCE_HAS_PAYMENTS',
        message: 'Odeme alinmis adisyon birlestirilemez; once odemeyi iade edin.',
      });
    }

    const updatedTarget = await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.updateMany({
        where: { orderId: sourceOrderId, deletedAt: null },
        data: { orderId: targetOrderId, version: { increment: 1 }, syncState: 'pending' },
      });
      await tx.orderDiscount.updateMany({
        where: { orderId: sourceOrderId, deletedAt: null },
        data: { orderId: targetOrderId, version: { increment: 1 }, syncState: 'pending' },
      });
      await tx.order.update({
        where: { id: sourceOrderId },
        data: {
          status: OrderStatus.Cancelled,
          closedBy: user.userId,
          closedAt: new Date(),
          note: `Birlestirildi -> ${target.orderNo}`,
          version: { increment: 1 },
          syncState: 'pending',
        },
      });
      await this.recompute(sourceOrderId, tx);
      return this.recompute(targetOrderId, tx);
    });
    if (source.tableId) await this.freeTableIfNoOpenOrder(user.branchId, source.tableId);

    await this.audit.record({
      branchId: user.branchId,
      action: 'order.merge',
      entityType: 'order',
      entityId: targetOrderId,
      userId: user.userId,
      oldValue: { sourceOrderId, sourceOrderNo: source.orderNo },
      newValue: { targetOrderId, targetOrderNo: target.orderNo },
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updatedTarget);
    const cancelledSource = await this.orderOrThrow(user.branchId, sourceOrderId);
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, cancelledSource);
    return this.orderWithItems(targetOrderId);
  }

  // Adisyonu boler: secili kalemler yeni bir adisyona (istege bagli bos masaya)
  // tasinir; kaynak adisyon acik kalir. Adisyon-seviyesi indirimler kaynakta kalir.
  // En az bir kalem kaynakta kalmali (tumu tasinacaksa masa-tasi kullanilir).
  // parentOrderId ile bolme soyagaci izlenir.
  async splitOrder(user: AuthUser, sourceOrderId: string, dto: SplitOrderDto) {
    const source = await this.orderOpenOrThrow(user.branchId, sourceOrderId);
    const items = await this.prisma.orderItem.findMany({
      where: { id: { in: dto.itemIds }, orderId: sourceOrderId, deletedAt: null },
    });
    if (items.length !== dto.itemIds.length) {
      throw new BadRequestException({
        code: 'SPLIT_ITEMS_INVALID',
        message: 'Secili kalemlerden bazilari bu adisyonda degil.',
      });
    }
    const remaining = await this.prisma.orderItem.count({
      where: { orderId: sourceOrderId, deletedAt: null, id: { notIn: dto.itemIds } },
    });
    if (remaining === 0) {
      throw new BadRequestException({
        code: 'SPLIT_EMPTY_SOURCE',
        message: 'Tum kalemler bolunemez; kaynakta en az bir kalem kalmali (masa-tasi kullanin).',
      });
    }
    // Odemeler kaynakta kalir: tasinan kalemler kaynak toplamini alinan
    // odemenin altina dusuremez (iptal kalemler toplami etkilemez).
    const movedNet = items
      .filter((i) => i.status !== OrderItemStatus.Cancelled)
      .reduce((s, i) => s + i.lineTotal, 0);
    await this.assertNotBelowPaid(sourceOrderId, source.grandTotal, source.grandTotal - movedNet);
    if (dto.targetTableId) {
      await this.tableOrThrow(user.branchId, dto.targetTableId);
      const occupied = await this.prisma.order.findFirst({
        where: {
          branchId: user.branchId,
          tableId: dto.targetTableId,
          status: { in: [OrderStatus.Open, OrderStatus.Held] },
          deletedAt: null,
        },
      });
      if (occupied) {
        throw new ConflictException({
          code: 'TABLE_HAS_OPEN_ORDER',
          message: 'Hedef masada acik adisyon var.',
        });
      }
    }

    const newOrderId = newId();
    const { updatedSource, newOrder } = await this.prisma.$transaction(async (tx) => {
      const orderNo = await this.generateOrderNo(tx, user.branchId);
      await tx.order.create({
        data: {
          id: newOrderId,
          branchId: user.branchId,
          tableId: dto.targetTableId ?? null,
          parentOrderId: sourceOrderId,
          orderNo,
          status: OrderStatus.Open,
          openedBy: user.userId,
          openedAt: new Date(),
          guestCount: 1,
          note: `Bolundu <- ${source.orderNo}`,
          ...this.provenance(user),
        },
      });
      await tx.orderItem.updateMany({
        where: { id: { in: dto.itemIds }, orderId: sourceOrderId, deletedAt: null },
        data: { orderId: newOrderId, version: { increment: 1 }, syncState: 'pending' },
      });
      if (dto.targetTableId) {
        await tx.table.update({
          where: { id: dto.targetTableId },
          data: { status: TableStatus.Occupied, version: { increment: 1 }, syncState: 'pending' },
        });
      }
      return {
        updatedSource: await this.recompute(sourceOrderId, tx),
        newOrder: await this.recompute(newOrderId, tx),
      };
    });

    await this.audit.record({
      branchId: user.branchId,
      action: 'order.split',
      entityType: 'order',
      entityId: newOrderId,
      userId: user.userId,
      oldValue: { sourceOrderId, sourceOrderNo: source.orderNo },
      newValue: {
        newOrderId,
        itemIds: dto.itemIds,
        targetTableId: dto.targetTableId ?? null,
      },
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderCreated, newOrder);
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updatedSource);
    return {
      source: await this.orderWithItems(sourceOrderId),
      created: await this.orderWithItems(newOrderId),
    };
  }

  // ===========================================================================
  // Mutfaga iletme (send-kitchen)
  // ===========================================================================
  // Bekleyen (pending) kalemleri mutfaga iletir: status -> sent, sentToKitchenAt
  // damgalanir (artik duzenlenemez, void gerekir). order.item.sent yayinlanir ->
  // yazdirma modulu hazirlik fisi basar.
  async sendToKitchen(user: AuthUser, orderId: string) {
    await this.orderOpenOrThrow(user.branchId, orderId);
    const pending = await this.prisma.$transaction(async (tx) => {
      const candidates = await tx.orderItem.findMany({
        where: { orderId, status: OrderItemStatus.Pending, deletedAt: null },
      });
      const claimed: typeof candidates = [];
      for (const item of candidates) {
        const updated = await tx.orderItem.updateMany({
          where: {
            id: item.id,
            orderId,
            status: OrderItemStatus.Pending,
            deletedAt: null,
            version: item.version,
          },
          data: {
            status: OrderItemStatus.Sent,
            sentToKitchenAt: new Date(),
            version: { increment: 1 },
            syncState: 'pending',
          },
        });
        if (updated.count === 1) claimed.push(item);
      }
      if (claimed.length) {
        await this.events.publishDurable(
          tx,
          createDomainEvent(
            DomainEventName.OrderItemSent,
            {
              orderId,
              items: claimed.map((item) => ({
                orderItemId: item.id,
                productId: item.productId,
                productName: item.productNameSnapshot,
                quantity: item.quantity,
              })),
            },
            {
              branchId: user.branchId,
              actorId: user.userId,
              ...(user.deviceId ? { deviceId: user.deviceId } : {}),
            },
          ),
        );
      }
      return claimed;
    });
    if (pending.length === 0) {
      throw new ConflictException({
        code: 'NOTHING_TO_SEND',
        message: 'Mutfaga iletilecek yeni kalem yok.',
      });
    }
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.send_kitchen',
      entityType: 'order',
      entityId: orderId,
      userId: user.userId,
      newValue: { sentItemIds: pending.map((i) => i.id) },
      ...this.provenance(user),
    });
    return this.orderWithItems(orderId);
  }

  // ===========================================================================
  // Adisyon-seviyesi indirim
  // ===========================================================================
  async applyDiscount(user: AuthUser, orderId: string, dto: ApplyDiscountDto) {
    const order = await this.orderOpenOrThrow(user.branchId, orderId);

    let amount: number;
    if (dto.type === 'percent') {
      if (dto.value > 100) {
        throw new BadRequestException({ code: 'DISCOUNT_INVALID', message: 'Yuzde 100 asamaz.' });
      }
      amount = Math.round((order.subtotal * dto.value) / 100);
    } else {
      amount = dto.value; // kurus
    }
    if (amount <= 0) {
      throw new BadRequestException({
        code: 'DISCOUNT_INVALID',
        message: 'Indirim tutari gecersiz.',
      });
    }
    // Toplam indirim (satir + adisyon) ara toplami asamaz -> grandTotal negatif olmaz.
    if (order.discountTotal + amount > order.subtotal) {
      throw new BadRequestException({
        code: 'DISCOUNT_EXCEEDS',
        message: 'Toplam indirim ara toplami asamaz.',
      });
    }
    await this.assertNotBelowPaid(orderId, order.grandTotal, order.grandTotal - amount);
    // Yetki esigi: ara toplamin %10'unu asan indirim tam-yetki (Owner) gerektirir.
    const hasFull = user.permissions.includes(Permission.DiscountApplyFull);
    const ratio = order.subtotal > 0 ? amount / order.subtotal : 1;
    if (ratio > 0.1 && !hasFull) {
      throw new ForbiddenException({
        code: 'DISCOUNT_NEEDS_APPROVAL',
        message: '%10 uzeri indirim Owner onayi gerektirir.',
      });
    }

    const id = newId();
    const { discount, updated } = await this.prisma.$transaction(async (tx) => {
      const discount = await tx.orderDiscount.create({
        data: {
          id,
          orderId,
          type: dto.type,
          value: dto.value,
          amount,
          appliedBy: user.userId,
          reason: dto.reason ?? null,
          approvedBy: hasFull ? user.userId : null,
          ...this.provenance(user),
        },
      });
      return { discount, updated: await this.recompute(orderId, tx) };
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.discount.apply',
      entityType: 'order_discount',
      entityId: id,
      userId: user.userId,
      newValue: discount,
      ...(dto.reason ? { reason: dto.reason } : {}),
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  async removeDiscount(user: AuthUser, orderId: string, discountId: string) {
    await this.orderOpenOrThrow(user.branchId, orderId);
    const discount = await this.prisma.orderDiscount.findFirst({
      where: { id: discountId, orderId, deletedAt: null },
    });
    if (!discount) {
      throw new NotFoundException({ code: 'DISCOUNT_NOT_FOUND', message: 'Indirim bulunamadi.' });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.orderDiscount.update({
        where: { id: discountId },
        data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
      });
      return this.recompute(orderId, tx);
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'order.discount.remove',
      entityType: 'order_discount',
      entityId: discountId,
      userId: user.userId,
      oldValue: discount,
      ...this.provenance(user),
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // ===========================================================================
  // Toplam motoru + yardimcilar (saf matematik: orders.calc.ts)
  // ===========================================================================
  // Adisyona alinmis NET odeme (tahsilat - iade).
  private async netPaid(orderId: string): Promise<number> {
    const [charges, refunds] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { orderId, direction: PaymentDirection.Charge, deletedAt: null },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: { orderId, direction: PaymentDirection.Refund, deletedAt: null },
        _sum: { amount: true },
      }),
    ]);
    return (charges._sum.amount ?? 0) - (refunds._sum.amount ?? 0);
  }

  // Toplami DUSUREN islem (indirim/void/miktar azalt/bolme) alinan odemenin
  // altina inemez: adisyon bir daha kapanamaz (recordPayment kalan<=0 reddeder)
  // ve sonsuza dek acik kalir. Once iade gerekir.
  private async assertNotBelowPaid(orderId: string, oldTotal: number, newTotal: number) {
    if (newTotal >= oldTotal) return; // artis/esit -> kontrol gereksiz
    const paid = await this.netPaid(orderId);
    if (paid > 0 && newTotal < paid) {
      throw new ConflictException({
        code: 'ORDER_PAID_EXCEEDS_TOTAL',
        message: 'Yeni toplam alinan odemenin altina inemez; once odemeyi iade edin.',
      });
    }
  }

  private async recompute(orderId: string, db: Prisma.TransactionClient = this.prisma) {
    const items = await db.orderItem.findMany({
      where: { orderId, deletedAt: null, status: { not: OrderItemStatus.Cancelled } },
      select: { lineTotal: true, lineDiscount: true, taxRatePermille: true },
    });
    // Adisyon-seviyesi indirimler (satir indirimine EK). taxTotal bilgi amacli
    // satir bazinda kalir (ponytail: bilgi fisi, resmi mali degil).
    const orderDiscounts = await db.orderDiscount.findMany({
      where: { orderId, deletedAt: null },
      select: { amount: true },
    });
    const totals = applyOrderDiscounts(
      computeItemTotals(items),
      orderDiscounts.map((d) => d.amount),
    );
    if (totals.discountTotal > totals.subtotal || totals.grandTotal < 0) {
      throw new ConflictException({
        code: 'DISCOUNT_EXCEEDS',
        message: 'Toplam indirim ara toplami asamaz.',
      });
    }
    const paymentTotals = await db.payment.groupBy({
      by: ['direction'],
      where: { orderId, deletedAt: null },
      _sum: { amount: true },
    });
    const paid = paymentTotals.reduce(
      (sum, row) =>
        sum + (row.direction === PaymentDirection.Refund ? -1 : 1) * (row._sum.amount ?? 0),
      0,
    );
    if (totals.grandTotal < paid) {
      throw new ConflictException({
        code: 'ORDER_PAID_EXCEEDS_TOTAL',
        message: 'Yeni toplam alinan odemenin altina inemez; once odemeyi iade edin.',
      });
    }
    return db.order.update({
      where: { id: orderId },
      data: {
        ...totals,
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
  }

  // orderNo = YYYYMMDD-#### (is-gunu bazli gunluk sira). Transaction icinde cagrilir
  // (SQLite tek-yazar -> sayac yarisi pratikte serilesir).
  private async generateOrderNo(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    branchId: string,
  ): Promise<string> {
    const now = new Date();
    const start = new Date(now);
    if (now.getHours() < DAY_END_HOUR) start.setDate(start.getDate() - 1);
    start.setHours(DAY_END_HOUR, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const dateStr =
      `${start.getFullYear()}` +
      `${String(start.getMonth() + 1).padStart(2, '0')}` +
      `${String(start.getDate()).padStart(2, '0')}`;
    const count = await tx.order.count({
      where: { branchId, openedAt: { gte: start, lt: end } },
    });
    return `${dateStr}-${String(count + 1).padStart(4, '0')}`;
  }

  private async freeTableIfNoOpenOrder(branchId: string, tableId: string): Promise<void> {
    const stillOpen = await this.prisma.order.count({
      where: {
        branchId,
        tableId,
        status: { in: [OrderStatus.Open, OrderStatus.Held] },
        deletedAt: null,
      },
    });
    if (stillOpen === 0) {
      await this.prisma.table.update({
        where: { id: tableId },
        data: { status: TableStatus.Empty, version: { increment: 1 }, syncState: 'pending' },
      });
    }
  }

  private assertItemEditable(item: { status: string }): void {
    // PR1: gonderilmemis (pending) kalem duzenlenebilir/silinebilir. Gonderilmis kalem
    // (sent/preparing/served) -> void gerekir. Iptal edilmis -> islenmez.
    if (item.status !== OrderItemStatus.Pending) {
      throw new ConflictException({
        code: 'ITEM_NOT_EDITABLE',
        message: 'Yalnizca gonderilmemis kalem duzenlenebilir; gonderilmisi void edin.',
      });
    }
  }

  private async orderOrThrow(branchId: string, id: string) {
    const row = await this.prisma.order.findFirst({ where: { id, branchId, deletedAt: null } });
    if (!row)
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadi.' });
    return row;
  }

  private async orderOpenOrThrow(branchId: string, id: string) {
    const order = await this.orderOrThrow(branchId, id);
    if (order.status !== OrderStatus.Open) {
      throw new ConflictException({ code: 'ORDER_NOT_OPEN', message: 'Adisyon acik degil.' });
    }
    await this.requireOpenCashSession(branchId);
    return order;
  }

  private async requireOpenCashSession(
    branchId: string,
    db: Pick<Prisma.TransactionClient, 'cashSession'> = this.prisma,
  ): Promise<void> {
    const session = await db.cashSession.findFirst({
      where: { branchId, status: 'open', deletedAt: null },
      select: { id: true },
    });
    if (!session) {
      throw new ConflictException({
        code: 'CASH_SESSION_REQUIRED',
        message: 'Yeni adisyon veya sipariş işlemi için önce kasa oturumu açılmalıdır.',
      });
    }
  }

  private async orderWithItems(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: {
        items: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: {
            notes: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true, note: true, type: true },
            },
          },
        },
        discounts: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        table: { select: { id: true, name: true, hall: { select: { name: true } } } },
      },
    });
  }

  private async orderWithItemsOrThrow(branchId: string, id: string) {
    await this.orderOrThrow(branchId, id);
    return this.orderWithItems(id);
  }

  private async itemOrThrow(orderId: string, itemId: string) {
    const row = await this.prisma.orderItem.findFirst({
      where: { id: itemId, orderId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'ORDER_ITEM_NOT_FOUND', message: 'Kalem bulunamadi.' });
    }
    return row;
  }

  private async productForOrder(branchId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, branchId, deletedAt: null },
      include: { tax: true },
    });
    if (!product) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Urun bulunamadi.' });
    }
    // "Tukendi" isaretli urun siparise eklenemez (QR menu ile ayni bilgi).
    if (!product.isAvailable) {
      throw new ConflictException({ code: 'PRODUCT_UNAVAILABLE', message: 'Ürün tükendi.' });
    }
    return product;
  }

  private async publishOrderEvent(
    user: AuthUser,
    name: (typeof DomainEventName)[keyof typeof DomainEventName],
    order: {
      id: string;
      orderNo: string;
      tableId: string | null;
      status: string;
      grandTotal: number;
    },
  ): Promise<void> {
    await this.events.publish(
      createDomainEvent(
        name,
        {
          orderId: order.id,
          orderNo: order.orderNo,
          ...(order.tableId ? { tableId: order.tableId } : {}),
          status: order.status,
          grandTotal: order.grandTotal,
        },
        {
          branchId: user.branchId,
          actorId: user.userId,
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
      ),
    );
  }

  private async publishOrderItemEvent(
    user: AuthUser,
    name: (typeof DomainEventName)[keyof typeof DomainEventName],
    payload: {
      orderId: string;
      orderItemId: string;
      productId: string;
      quantity: number;
      lineTotal: number;
    },
  ): Promise<void> {
    await this.events.publish(
      createDomainEvent(name, payload, {
        branchId: user.branchId,
        actorId: user.userId,
        ...(user.deviceId ? { deviceId: user.deviceId } : {}),
      }),
    );
  }

  private async tableOrThrow(branchId: string, id: string) {
    const row = await this.prisma.table.findFirst({ where: { id, branchId, deletedAt: null } });
    if (!row) throw new NotFoundException({ code: 'TABLE_NOT_FOUND', message: 'Masa bulunamadi.' });
    return row;
  }
}

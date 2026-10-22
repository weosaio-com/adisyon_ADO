import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Order, Prisma } from '@prisma/client';
import {
  newId,
  createDomainEvent,
  DomainEventName,
  OrderStatus,
  OrderType,
  OrderItemStatus,
  TableStatus,
  Permission,
  WAITER_MAX_DISCOUNT_PERMILLE,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, type AuditEntry } from '../common/audit/audit.service';
import { EventBusService } from '../common/events/event-bus.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { LicenseService } from '../license/license.service';
import { computeItemTotals, applyOrderDiscounts } from './orders.calc';
import { assertMoneyWithinLimit, formatTl } from '../payments/money-limits';
import {
  ACTIVE_ORDER_STATUSES,
  activeOrderOnTableTx,
  completeOrderTx,
  freeTableIfIdleTx,
  isUniqueViolation,
  netPaidTx,
  orderChangedError,
  writeOrderTx,
  type Tx,
} from './order-tx';
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
/**
 * Iptal/void/indirim gerekcesi zorunlu (URN-3): "neden iptal edildi / neden indirim
 * yapildi" sorusunun cevabi denetim kaydinda kalsin. Bos ya da yalniz bosluk -> 400.
 */
function requireReason(reason: string | null | undefined, message: string): string {
  const text = reason?.trim() ?? '';
  if (!text) throw new BadRequestException({ code: 'REASON_REQUIRED', message });
  return text;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly license: LicenseService,
  ) {}

  private provenance(user: AuthUser): { deviceId?: string } {
    return user.deviceId ? { deviceId: user.deviceId } : {};
  }

  // Denetim kaydi ana islemin ICINDE: kayit yazilamazsa islem de geri alinir (kayitsiz
  // degisiklik ya da "kaydedildi ama istemciye hata dondu" durumu olusmaz).
  private auditTx(
    tx: Tx,
    user: AuthUser,
    entry: Omit<AuditEntry, 'branchId' | 'userId' | 'deviceId'>,
  ): Promise<string> {
    return this.audit.recordTx(tx, {
      ...entry,
      branchId: user.branchId,
      userId: user.userId,
      ...this.provenance(user),
    });
  }

  // ===========================================================================
  // Adisyon
  // ===========================================================================
  async openOrder(user: AuthUser, dto: OpenOrderDto) {
    // Idempotency: ayni clientOpId ile tekrar gelirse mevcut adisyonu don.
    if (dto.clientOpId) {
      const existing = await this.existingOrderByOp(user, dto.clientOpId);
      if (existing) return existing;
    }

    // Lisans kilidi YALNIZ yeni adisyonu durdurur (acik adisyon odenir/kapanir; bolme serbest).
    // Cevrimdisi islem kilitten once tablette olusturulduysa (clientOpId ULID zamani) gecer.
    await this.license.assertCanOpenOrder(user.branchId, { clientOpId: dto.clientOpId });

    const id = newId();
    let created;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await this.requireOpenCashSession(user.branchId, tx);
        if (dto.tableId) {
          await this.tableOrThrow(user.branchId, dto.tableId, tx);
          await this.assertTableFree(
            tx,
            user.branchId,
            dto.tableId,
            'Masada zaten acik adisyon var.',
          );
        }
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
        await this.auditTx(tx, user, {
          action: 'order.open',
          entityType: 'order',
          entityId: id,
          newValue: order,
        });
        return order;
      });
    } catch (e) {
      // Yaris: ayni masaya/ayni anahtarla es zamanli acilis benzersiz indekse takilir.
      // Genel DATA_CONFLICT yerine anlamli sonuc: ayni anahtar -> idempotent, masa dolu -> 409.
      if (!isUniqueViolation(e)) throw e;
      if (dto.clientOpId) {
        const existing = await this.existingOrderByOp(user, dto.clientOpId);
        if (existing) return existing;
      }
      if (dto.tableId) {
        const active = await activeOrderOnTableTx(this.prisma, user.branchId, dto.tableId);
        if (active) throw this.tableHasOpenOrder('Masada zaten acik adisyon var.', active.id);
      }
      throw e;
    }

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

  // Odemesi tamamlanmis acik adisyonu kapatir: toplami 0 olan (tam indirim/ikram, sifir
  // fiyatli urun) ya da kalani 0'a dusmus adisyon. Para hareketi yazilmaz.
  async closeOrder(user: AuthUser, id: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, id);
      const activeItems = await tx.orderItem.count({
        where: { orderId: id, deletedAt: null, status: { not: OrderItemStatus.Cancelled } },
      });
      if (activeItems === 0) {
        throw new ConflictException({
          code: 'ORDER_EMPTY',
          message: 'Adisyonda ürün yok; boş adisyonu kapatmak için iptal edin.',
        });
      }
      const paid = await netPaidTx(tx, id);
      if (paid < order.grandTotal) {
        throw new ConflictException({
          code: 'ORDER_HAS_BALANCE',
          message: `Adisyonda ödenmemiş ${formatTl(order.grandTotal - paid)} var; kapatmak için ödeme alın.`,
        });
      }
      const updated = await this.settleInTx(tx, user, order);
      await this.auditTx(tx, user, {
        action: 'order.close',
        entityType: 'order',
        entityId: id,
        oldValue: order,
        newValue: updated,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(id);
  }

  async cancelOrder(user: AuthUser, id: string, dto: CancelOrderDto) {
    const reason = requireReason(dto.reason, 'Adisyon iptali için gerekçe yazın.');
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, user.branchId, id);
      const updated = await this.cancelInTx(tx, user, order, reason);
      await this.auditTx(tx, user, {
        action: 'order.cancel',
        entityType: 'order',
        entityId: id,
        oldValue: order,
        newValue: updated,
        reason,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(id);
  }

  // ===========================================================================
  // Kalem
  // ===========================================================================
  async addItem(user: AuthUser, orderId: string, dto: AddItemDto) {
    if (dto.clientOpId) {
      const replay = await this.existingItemByOp(user, orderId, dto.clientOpId);
      if (replay) return replay;
    }

    const itemId = newId();
    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const order = await this.lockOpenOrder(tx, user.branchId, orderId);
        // Ayni anahtar islem icinde de aranir: es zamanli tekrar ikinci kalem acmaz.
        if (
          dto.clientOpId &&
          (await tx.orderItem.findUnique({ where: { clientOpId: dto.clientOpId } }))
        ) {
          return null;
        }
        const product = await this.productForOrder(user.branchId, dto.productId, tx);
        const gross = Math.round((product.salePrice * dto.quantity) / 1000);
        const lineTotal = gross; // lineDiscount 0 (satir indirimi PR2)
        assertMoneyWithinLimit(lineTotal, 'Kalem tutarı');
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
        const updated = await this.recompute(tx, user, order);
        await this.auditTx(tx, user, {
          action: 'order.item.add',
          entityType: 'order_item',
          entityId: itemId,
          newValue: item,
        });
        return { product, lineTotal, updated };
      });
    } catch (e) {
      if (dto.clientOpId && isUniqueViolation(e)) {
        const replay = await this.existingItemByOp(user, orderId, dto.clientOpId);
        if (replay) return replay;
      }
      throw e;
    }
    if (!result) return this.orderWithItems(orderId);

    const { product, lineTotal, updated } = result;
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
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, orderId);
      const item = await this.itemOrThrow(orderId, itemId, tx);
      this.assertItemEditable(item);
      const gross = Math.round((item.unitPrice * dto.quantity) / 1000);
      assertMoneyWithinLimit(gross, 'Kalem tutarı');
      await this.writeItem(tx, item, {
        quantity: dto.quantity,
        lineTotal: gross - item.lineDiscount,
      });
      // Toplam alinan odemenin altina inerse recompute ORDER_PAID_EXCEEDS_TOTAL atar (geri alinir).
      const updated = await this.recompute(tx, user, order);
      await this.auditTx(tx, user, {
        action: 'order.item.update',
        entityType: 'order_item',
        entityId: itemId,
        oldValue: item,
        newValue: { quantity: dto.quantity },
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  async removeItem(user: AuthUser, orderId: string, itemId: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, orderId);
      const item = await this.itemOrThrow(orderId, itemId, tx);
      this.assertItemEditable(item);
      await this.writeItem(tx, item, { deletedAt: new Date() });
      const updated = await this.recompute(tx, user, order);
      await this.auditTx(tx, user, {
        action: 'order.item.remove',
        entityType: 'order_item',
        entityId: itemId,
        oldValue: item,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // Tek garson notu: yoksa olustur, varsa guncelle, bos gelirse sil. Gonderilmis kaleme
  // not eklenmez (mutfak fisi basildi; degisiklik icin void + yeni kalem).
  async setItemNote(user: AuthUser, orderId: string, itemId: string, dto: ItemNoteDto) {
    const text = dto.note?.trim() ?? '';
    const order = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, orderId);
      const item = await this.itemOrThrow(orderId, itemId, tx);
      this.assertItemEditable(item);
      const existing = await tx.orderItemNote.findFirst({
        where: { orderItemId: itemId, type: 'waiter', deletedAt: null },
      });
      if (existing && !text) {
        await tx.orderItemNote.update({
          where: { id: existing.id },
          data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
        });
      } else if (existing) {
        await tx.orderItemNote.update({
          where: { id: existing.id },
          data: { note: text, version: { increment: 1 }, syncState: 'pending' },
        });
      } else if (text) {
        await tx.orderItemNote.create({
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
      await this.auditTx(tx, user, {
        action: 'order.item.note',
        entityType: 'order_item',
        entityId: itemId,
        oldValue: existing?.note ?? null,
        newValue: text || null,
      });
      return order;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, order);
    return this.orderWithItems(orderId);
  }

  // Yanlislikla acilan masa: aktif kalemi ve odemesi olmayan adisyon kapatilir (masa bosalir).
  async discardEmptyOrder(user: AuthUser, id: string) {
    const reason = 'Boş adisyon kapatıldı';
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, user.branchId, id);
      const activeItems = await tx.orderItem.count({
        where: { orderId: id, deletedAt: null, status: { not: OrderItemStatus.Cancelled } },
      });
      if (activeItems > 0) {
        throw new ConflictException({
          code: 'ORDER_NOT_EMPTY',
          message: 'Adisyonda ürün var; dolu adisyonu yalnızca yönetici iptal edebilir.',
        });
      }
      const updated = await this.cancelInTx(tx, user, order, reason);
      await this.auditTx(tx, user, {
        action: 'order.cancel',
        entityType: 'order',
        entityId: id,
        oldValue: order,
        newValue: updated,
        reason,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(id);
  }

  // Void: gonderilmis/onaylanmis kalemi iptal eder (Owner). Satir kalir, status=cancelled.
  async voidItem(user: AuthUser, orderId: string, itemId: string, dto: VoidItemDto) {
    const reason = requireReason(dto.reason, 'Kalem iptali için gerekçe seçin.');
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, orderId);
      const item = await this.itemOrThrow(orderId, itemId, tx);
      if (item.status === OrderItemStatus.Cancelled) {
        throw new ConflictException({
          code: 'ITEM_ALREADY_VOID',
          message: 'Kalem zaten iptal edilmis.',
        });
      }
      await this.writeItem(tx, item, {
        status: OrderItemStatus.Cancelled,
        voidedBy: user.userId,
        voidReason: reason,
      });
      const updated = await this.recompute(tx, user, order);
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
      await this.auditTx(tx, user, {
        action: 'order.item.void',
        entityType: 'order_item',
        entityId: itemId,
        oldValue: item,
        reason,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // ===========================================================================
  // Beklet / tekrar ac + masa tasi
  // ===========================================================================
  async holdOrder(user: AuthUser, orderId: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, orderId);
      const updated = await writeOrderTx(tx, order, { status: OrderStatus.Held });
      await this.auditTx(tx, user, {
        action: 'order.hold',
        entityType: 'order',
        entityId: orderId,
        oldValue: order,
        newValue: updated,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  async resumeOrder(user: AuthUser, orderId: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, user.branchId, orderId);
      if (order.status !== OrderStatus.Held) {
        throw new ConflictException({
          code: 'ORDER_NOT_HELD',
          message: 'Yalnizca bekleyen adisyon tekrar acilabilir.',
        });
      }
      await this.requireOpenCashSession(user.branchId, tx);
      // Masasi baska acik adisyona kapildiysa engelle.
      if (order.tableId) {
        await this.assertTableFree(
          tx,
          user.branchId,
          order.tableId,
          'Masada acik adisyon var; once onu kapatin.',
          order.id,
        );
      }
      const updated = await writeOrderTx(tx, order, { status: OrderStatus.Open }, [
        OrderStatus.Held,
      ]);
      await this.auditTx(tx, user, {
        action: 'order.resume',
        entityType: 'order',
        entityId: orderId,
        oldValue: order,
        newValue: updated,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // Adisyonu baska (bos) masaya tasir. Eski masa serbest kalirsa bosaltilir.
  async moveTable(user: AuthUser, orderId: string, targetTableId: string) {
    const moved = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, orderId);
      if (order.tableId === targetTableId) return null;
      await this.tableOrThrow(user.branchId, targetTableId, tx);
      await this.assertTableFree(
        tx,
        user.branchId,
        targetTableId,
        'Hedef masada acik adisyon var.',
      );
      const updated = await writeOrderTx(tx, order, { tableId: targetTableId });
      await tx.table.update({
        where: { id: targetTableId },
        data: { status: TableStatus.Occupied, version: { increment: 1 }, syncState: 'pending' },
      });
      if (order.tableId) await freeTableIfIdleTx(tx, user.branchId, order.tableId);
      await this.auditTx(tx, user, {
        action: 'order.move_table',
        entityType: 'order',
        entityId: orderId,
        oldValue: { tableId: order.tableId },
        newValue: { tableId: targetTableId },
      });
      return updated;
    });
    if (!moved) return this.orderWithItems(orderId);

    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, moved);
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
    const { updatedTarget, cancelledSource } = await this.prisma.$transaction(async (tx) => {
      const target = await this.lockOpenOrder(tx, user.branchId, targetOrderId);
      const source = await this.lockOpenOrder(tx, user.branchId, sourceOrderId);

      // Kaynagin odemeleri hedefe TASINMAZ; odemeli kaynak birlesirse musteri
      // ayni tutari ikinci kez oder -> engelle.
      if ((await netPaidTx(tx, sourceOrderId)) > 0) {
        throw new ConflictException({
          code: 'MERGE_SOURCE_HAS_PAYMENTS',
          message: 'Odeme alinmis adisyon birlestirilemez; once odemeyi iade edin.',
        });
      }

      await tx.orderItem.updateMany({
        where: { orderId: sourceOrderId, deletedAt: null },
        data: { orderId: targetOrderId, version: { increment: 1 }, syncState: 'pending' },
      });
      await tx.orderDiscount.updateMany({
        where: { orderId: sourceOrderId, deletedAt: null },
        data: { orderId: targetOrderId, version: { increment: 1 }, syncState: 'pending' },
      });
      const cancelledSource = await writeOrderTx(tx, source, {
        ...(await this.computeTotals(tx, sourceOrderId)),
        status: OrderStatus.Cancelled,
        closedBy: user.userId,
        closedAt: new Date(),
        completedAt: null,
        note: `Birlestirildi -> ${target.orderNo}`,
      });
      const updatedTarget = await this.recompute(tx, user, target);
      if (source.tableId) await freeTableIfIdleTx(tx, user.branchId, source.tableId);
      await this.auditTx(tx, user, {
        action: 'order.merge',
        entityType: 'order',
        entityId: targetOrderId,
        oldValue: { sourceOrderId, sourceOrderNo: source.orderNo },
        newValue: { targetOrderId, targetOrderNo: target.orderNo },
      });
      return { updatedTarget, cancelledSource };
    });

    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updatedTarget);
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, cancelledSource);
    return this.orderWithItems(targetOrderId);
  }

  // Adisyonu boler: secili kalemler yeni bir adisyona (istege bagli bos masaya)
  // tasinir; kaynak adisyon acik kalir. Adisyon-seviyesi indirimler kaynakta kalir.
  // En az bir kalem kaynakta kalmali (tumu tasinacaksa masa-tasi kullanilir).
  // parentOrderId ile bolme soyagaci izlenir.
  async splitOrder(user: AuthUser, sourceOrderId: string, dto: SplitOrderDto) {
    const newOrderId = newId();
    const { updatedSource, newOrder } = await this.prisma.$transaction(async (tx) => {
      const source = await this.lockOpenOrder(tx, user.branchId, sourceOrderId);
      const items = await tx.orderItem.findMany({
        where: { id: { in: dto.itemIds }, orderId: sourceOrderId, deletedAt: null },
      });
      if (items.length !== dto.itemIds.length) {
        throw new BadRequestException({
          code: 'SPLIT_ITEMS_INVALID',
          message: 'Secili kalemlerden bazilari bu adisyonda degil.',
        });
      }
      const remaining = await tx.orderItem.count({
        where: { orderId: sourceOrderId, deletedAt: null, id: { notIn: dto.itemIds } },
      });
      if (remaining === 0) {
        throw new BadRequestException({
          code: 'SPLIT_EMPTY_SOURCE',
          message: 'Tum kalemler bolunemez; kaynakta en az bir kalem kalmali (masa-tasi kullanin).',
        });
      }
      if (dto.targetTableId) {
        await this.tableOrThrow(user.branchId, dto.targetTableId, tx);
        await this.assertTableFree(
          tx,
          user.branchId,
          dto.targetTableId,
          'Hedef masada acik adisyon var.',
        );
      }

      const orderNo = await this.generateOrderNo(tx, user.branchId);
      const created = await tx.order.create({
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
      // Odemeler kaynakta kalir: tasinan kalemler kaynak toplamini alinan odemenin
      // altina dusuremez (recompute ORDER_PAID_EXCEEDS_TOTAL atar, islem geri alinir).
      const updatedSource = await this.recompute(tx, user, source);
      const newOrder = await this.recompute(tx, user, created);
      await this.auditTx(tx, user, {
        action: 'order.split',
        entityType: 'order',
        entityId: newOrderId,
        oldValue: { sourceOrderId, sourceOrderNo: source.orderNo },
        newValue: {
          newOrderId,
          itemIds: dto.itemIds,
          targetTableId: dto.targetTableId ?? null,
        },
      });
      return { updatedSource, newOrder };
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
  // opts.itemIds: yalniz bu kalemler gonderilir (cevrimdisi siparis baska tabletin acik
  // adisyonuyla birlesince o garsonun henuz gondermedigi kalemler mutfaga gitmesin).
  async sendToKitchen(user: AuthUser, orderId: string, opts: { itemIds?: string[] } = {}) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpenOrder(tx, user.branchId, orderId);
      const candidates = await tx.orderItem.findMany({
        where: {
          orderId,
          status: OrderItemStatus.Pending,
          deletedAt: null,
          ...(opts.itemIds ? { id: { in: opts.itemIds } } : {}),
        },
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
      if (claimed.length === 0) {
        throw new ConflictException({
          code: 'NOTHING_TO_SEND',
          message: 'Mutfaga iletilecek yeni kalem yok.',
        });
      }
      await this.auditTx(tx, user, {
        action: 'order.send_kitchen',
        entityType: 'order',
        entityId: orderId,
        newValue: { sentItemIds: claimed.map((i) => i.id) },
      });
    });
    return this.orderWithItems(orderId);
  }

  // ===========================================================================
  // Adisyon-seviyesi indirim
  // ===========================================================================
  async applyDiscount(user: AuthUser, orderId: string, dto: ApplyDiscountDto) {
    // Tekrar korumasi: ayni clientOpId ile gelen ikinci istek ikinci indirim acmaz.
    if (dto.clientOpId) {
      const replay = await this.existingDiscountByOp(user, orderId, dto.clientOpId);
      if (replay) return replay;
    }
    const reason = requireReason(dto.reason, 'İndirim için gerekçe yazın.');
    const hasFull = user.permissions.includes(Permission.DiscountApplyFull);
    const id = newId();
    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const order = await this.lockOpenOrder(tx, user.branchId, orderId);
        if (
          dto.clientOpId &&
          (await tx.orderDiscount.findUnique({ where: { clientOpId: dto.clientOpId } }))
        ) {
          return null;
        }

        let amount: number;
        if (dto.type === 'percent') {
          if (dto.value > 100) {
            throw new BadRequestException({
              code: 'DISCOUNT_INVALID',
              message: 'Yuzde 100 asamaz.',
            });
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
        // Yetki esigi TOPLAM indirim uzerinden: mevcut indirimler + yenisi ara toplamin
        // %10'unu asarsa tam yetki (Owner) gerekir. Yalniz yenisine bakilinca garson %10'u
        // ust uste ekleyerek sinirsiz indirim yapabiliyordu.
        const overLimit =
          (order.discountTotal + amount) * 1000 > order.subtotal * WAITER_MAX_DISCOUNT_PERMILLE;
        if (overLimit && !hasFull) {
          throw new ForbiddenException({
            code: 'DISCOUNT_NEEDS_APPROVAL',
            message: "Toplam indirim ara toplamın %10'unu aşıyor; yönetici onayı gerekir.",
          });
        }

        const discount = await tx.orderDiscount.create({
          data: {
            id,
            orderId,
            type: dto.type,
            value: dto.value,
            amount,
            appliedBy: user.userId,
            reason,
            approvedBy: hasFull ? user.userId : null,
            ...(dto.clientOpId ? { clientOpId: dto.clientOpId } : {}),
            ...this.provenance(user),
          },
        });
        // Toplam alinan odemenin altina inerse recompute ORDER_PAID_EXCEEDS_TOTAL atar.
        const updated = await this.recompute(tx, user, order);
        await this.auditTx(tx, user, {
          action: 'order.discount.apply',
          entityType: 'order_discount',
          entityId: id,
          newValue: discount,
          reason,
        });
        return updated;
      });
    } catch (e) {
      if (dto.clientOpId && isUniqueViolation(e)) {
        const replay = await this.existingDiscountByOp(user, orderId, dto.clientOpId);
        if (replay) return replay;
      }
      throw e;
    }
    if (!updated) return this.orderWithItems(orderId);
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  async removeDiscount(user: AuthUser, orderId: string, discountId: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOpenOrder(tx, user.branchId, orderId);
      const discount = await tx.orderDiscount.findFirst({
        where: { id: discountId, orderId, deletedAt: null },
      });
      if (!discount) {
        throw new NotFoundException({ code: 'DISCOUNT_NOT_FOUND', message: 'Indirim bulunamadi.' });
      }
      const removed = await tx.orderDiscount.updateMany({
        where: { id: discountId, version: discount.version, deletedAt: null },
        data: { deletedAt: new Date(), version: { increment: 1 }, syncState: 'pending' },
      });
      if (removed.count !== 1) throw orderChangedError();
      const updated = await this.recompute(tx, user, order);
      await this.auditTx(tx, user, {
        action: 'order.discount.remove',
        entityType: 'order_discount',
        entityId: discountId,
        oldValue: discount,
      });
      return updated;
    });
    await this.publishOrderEvent(user, DomainEventName.OrderUpdated, updated);
    return this.orderWithItems(orderId);
  }

  // ===========================================================================
  // Toplam motoru + yardimcilar (saf matematik: orders.calc.ts)
  // ===========================================================================
  // Iptal cekirdegi (cancel + discard ortak): yalniz acik/bekleyen, odemesiz adisyon.
  private async cancelInTx(tx: Tx, user: AuthUser, order: Order, reason?: string | null) {
    if (order.status !== OrderStatus.Open && order.status !== OrderStatus.Held) {
      throw new ConflictException({
        code: 'ORDER_NOT_CANCELABLE',
        message: 'Yalnizca acik/bekleyen adisyon iptal edilebilir.',
      });
    }
    // Odemesi alinmis adisyon iptal edilemez: para kayitlarda bosta kalir.
    if ((await netPaidTx(tx, order.id)) > 0) {
      throw new ConflictException({
        code: 'ORDER_HAS_PAYMENTS',
        message: 'Odeme alinmis adisyon iptal edilemez; once odemeyi iade edin.',
      });
    }
    const updated = await writeOrderTx(
      tx,
      order,
      {
        status: OrderStatus.Cancelled,
        closedBy: user.userId,
        closedAt: new Date(),
        completedAt: null, // iptal satis degildir (iade + iptal Z raporunda kalmaz)
        note: reason ?? order.note,
      },
      ACTIVE_ORDER_STATUSES,
    );
    if (order.tableId) await freeTableIfIdleTx(tx, user.branchId, order.tableId);
    return updated;
  }

  // Kalem satirini YALNIZ okundugu surumdeyse gunceller (es zamanli gonderim/iptal korunur).
  private async writeItem(
    tx: Tx,
    item: { id: string; version: number },
    data: Prisma.OrderItemUncheckedUpdateManyInput,
  ) {
    const res = await tx.orderItem.updateMany({
      where: { id: item.id, version: item.version, deletedAt: null },
      data: { ...data, version: { increment: 1 }, syncState: 'pending' },
    });
    if (res.count !== 1) throw orderChangedError();
  }

  // Kalem + adisyon indirimlerinden toplamlar (islem icinde).
  private async computeTotals(tx: Tx, orderId: string) {
    const items = await tx.orderItem.findMany({
      where: { orderId, deletedAt: null, status: { not: OrderItemStatus.Cancelled } },
      select: { lineTotal: true, lineDiscount: true, taxRatePermille: true },
    });
    // Adisyon-seviyesi indirimler (satir indirimine EK). taxTotal bilgi amacli
    // satir bazinda kalir (ponytail: bilgi fisi, resmi mali degil).
    const orderDiscounts = await tx.orderDiscount.findMany({
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
    // Toplamlar 32-bit alana yazilir: ara toplam (en buyuk deger) sinirda tutulur.
    assertMoneyWithinLimit(totals.subtotal, 'Adisyon toplamı');
    return totals;
  }

  // Toplamlari yeniden hesaplar ve adisyona KOSULLU yazar: adisyon islem icinde
  // okundugu surumde ve acik degilse (arada odendi/kapandi) 409 -> islem geri alinir.
  // Kapali adisyonun toplami asla degismez.
  private async recompute(tx: Tx, user: AuthUser, order: Order) {
    const totals = await this.computeTotals(tx, order.id);
    const paid = await netPaidTx(tx, order.id);
    // Toplami DUSUREN islem (indirim/void/miktar azalt/bolme) alinan odemenin
    // altina inemez: once iade gerekir.
    if (totals.grandTotal < paid) {
      throw new ConflictException({
        code: 'ORDER_PAID_EXCEEDS_TOTAL',
        message: 'Yeni toplam alinan odemenin altina inemez; once odemeyi iade edin.',
      });
    }
    // Kismi odemeden sonra toplam alinan tutara inerse (void/indirim/bolme) adisyon
    // odeme yolundaki gibi kapanir; aksi halde kalan 0 olan adisyon sonsuza dek acik kalirdi.
    if (paid > 0 && paid >= totals.grandTotal) return this.settleInTx(tx, user, order, totals);
    return writeOrderTx(tx, order, totals);
  }

  // Odemesiz tamamlama (toplam karsilanmis): kapat + masa bosalt + order.paid (tutar 0).
  // order.paid dinleyicileri: kasa/veresiye yontem 'none' oldugu icin hareket yazmaz,
  // yazdirma adisyon odendi oldugu icin musteri fisini bir kez basar.
  private async settleInTx(
    tx: Tx,
    user: AuthUser,
    order: Order,
    data: Prisma.OrderUncheckedUpdateManyInput = {},
  ) {
    const updated = await completeOrderTx(tx, order, user.userId, data);
    await this.events.publishDurable(
      tx,
      createDomainEvent(
        DomainEventName.OrderPaid,
        { orderId: order.id, paymentId: null, amount: 0, method: 'none' },
        {
          branchId: user.branchId,
          actorId: user.userId,
          ...(user.deviceId ? { deviceId: user.deviceId } : {}),
        },
      ),
    );
    return updated;
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

  // Islem ICINDE adisyonu okur (kosullu yazimin surum kaynagi).
  private async lockOrder(tx: Tx, branchId: string, id: string): Promise<Order> {
    const row = await tx.order.findFirst({ where: { id, branchId, deletedAt: null } });
    if (!row)
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadi.' });
    return row;
  }

  // Islem ICINDE: adisyon acik olmali ve kasa oturumu acik olmali. Okunan surum,
  // islem sonundaki kosullu yazimda kullanilir (writeOrderTx / recompute).
  private async lockOpenOrder(tx: Tx, branchId: string, id: string): Promise<Order> {
    const order = await this.lockOrder(tx, branchId, id);
    if (order.status !== OrderStatus.Open) {
      throw new ConflictException({ code: 'ORDER_NOT_OPEN', message: 'Adisyon acik degil.' });
    }
    await this.requireOpenCashSession(branchId, tx);
    return order;
  }

  // Masa dolu ise 409 TABLE_HAS_OPEN_ORDER (+ masadaki adisyonun id'si: istemci ona gecer).
  private async assertTableFree(
    tx: Tx,
    branchId: string,
    tableId: string,
    message: string,
    exceptOrderId?: string,
  ): Promise<void> {
    const active = await activeOrderOnTableTx(tx, branchId, tableId, exceptOrderId);
    if (active) throw this.tableHasOpenOrder(message, active.id);
  }

  private tableHasOpenOrder(message: string, orderId: string): ConflictException {
    return new ConflictException({ code: 'TABLE_HAS_OPEN_ORDER', message, orderId });
  }

  // Ayni clientOpId ile acilmis adisyon (idempotent tekrar) ya da null.
  private async existingOrderByOp(user: AuthUser, clientOpId: string) {
    const existing = await this.prisma.order.findUnique({ where: { clientOpId } });
    if (!existing) return null;
    if (existing.branchId !== user.branchId) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Bu islem anahtari baska bir subede kullanilmis.',
      });
    }
    return this.orderWithItems(existing.id);
  }

  // Ayni clientOpId ile uygulanmis indirim (idempotent tekrar) ya da null.
  private async existingDiscountByOp(user: AuthUser, orderId: string, clientOpId: string) {
    const existing = await this.prisma.orderDiscount.findUnique({
      where: { clientOpId },
      include: { order: { select: { branchId: true } } },
    });
    if (!existing) return null;
    if (existing.orderId !== orderId || existing.order.branchId !== user.branchId) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Bu işlem anahtarı başka bir indirimde kullanılmış.',
      });
    }
    return this.orderWithItems(orderId);
  }

  // Ayni clientOpId ile eklenmis kalem (idempotent tekrar) ya da null.
  private async existingItemByOp(user: AuthUser, orderId: string, clientOpId: string) {
    const existing = await this.prisma.orderItem.findUnique({
      where: { clientOpId },
      include: { order: { select: { branchId: true } } },
    });
    if (!existing) return null;
    if (existing.orderId !== orderId || existing.order.branchId !== user.branchId) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Bu islem anahtari baska bir kalemde kullanilmis.',
      });
    }
    return this.orderWithItems(orderId);
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

  private async itemOrThrow(orderId: string, itemId: string, db: Tx = this.prisma) {
    const row = await db.orderItem.findFirst({
      where: { id: itemId, orderId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ code: 'ORDER_ITEM_NOT_FOUND', message: 'Kalem bulunamadi.' });
    }
    return row;
  }

  private async productForOrder(branchId: string, productId: string, db: Tx = this.prisma) {
    const product = await db.product.findFirst({
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

  private async tableOrThrow(branchId: string, id: string, db: Tx = this.prisma) {
    const row = await db.table.findFirst({ where: { id, branchId, deletedAt: null } });
    if (!row) throw new NotFoundException({ code: 'TABLE_NOT_FOUND', message: 'Masa bulunamadi.' });
    return row;
  }
}

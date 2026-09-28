import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  newId,
  AuditOrigin,
  OfflineMutationResult,
  OfflineMutationType,
  OfflineReviewReason,
  OfflineReviewStatus,
  OrderStatus,
  TableStatus,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { OrdersService } from '../orders/orders.service';
import { categoryView, productView } from '../catalog/catalog.views';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  addLinePayload,
  addNotePayload,
  openTablePayload,
  submitOrderPayload,
  updateLineQtyPayload,
} from './dto/sync.schemas';
import type { PushMutationsDto, ResolveReviewDto, SyncMutation } from './dto/sync.schemas';

/** Bir offline mutasyonun sunucu sonucu. OFFLINE_DESIGN.md §7.1 */
interface MutationResult {
  clientOpId: string;
  status: OfflineMutationResult;
  serverId?: string;
  reviewId?: string;
  reason?: string;
}

/**
 * Istemci-offline senkron cekirdegi (OFFLINE_DESIGN.md §7-9).
 * Mutasyonlar mevcut OrdersService uzerinden uygulanir -> online/offline ayni
 * kod yolu (karar E). Idempotency: ProcessedClientOp defteri + Order/OrderItem
 * uzerindeki unique clientOpId kolonlari (cift emniyet).
 * Cakisma: kapali/tasinan masa otomatik uygulanmaz -> PendingOfflineReview (K4).
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // Push: toplu mutasyon isleme (FIFO — istemci outbox sirasi dependsOn'u tasir)
  // ===========================================================================
  async pushMutations(user: AuthUser, dto: PushMutationsDto) {
    const results: MutationResult[] = [];
    for (const m of dto.mutations) {
      const prior = await this.prisma.processedClientOp.findUnique({
        where: { clientOpId: m.clientOpId },
      });
      if (prior) {
        if (prior.branchId !== user.branchId) {
          results.push({
            clientOpId: m.clientOpId,
            status: OfflineMutationResult.Rejected,
            reason: 'IDEMPOTENCY_KEY_REUSED',
          });
          continue;
        }
        // Deftere islenmis: yeniden islenmez, ilk sonuc doner (replay guvenli).
        results.push({
          clientOpId: m.clientOpId,
          status:
            prior.resultStatus === OfflineMutationResult.Applied
              ? OfflineMutationResult.Duplicate
              : (prior.resultStatus as OfflineMutationResult),
          ...(prior.resultRef ? { serverId: prior.resultRef } : {}),
        });
        continue;
      }
      const r = await this.dispatch(user, dto.deviceId, m);
      await this.prisma.processedClientOp.create({
        data: {
          id: newId(),
          branchId: user.branchId,
          clientOpId: m.clientOpId,
          deviceId: dto.deviceId,
          mutationType: m.type,
          resultStatus:
            r.status === OfflineMutationResult.Duplicate ? OfflineMutationResult.Applied : r.status,
          resultRef: r.serverId ?? r.reviewId ?? null,
        },
      });
      results.push(r);
    }
    return { results, serverTime: new Date().toISOString() };
  }

  // ===========================================================================
  // Snapshot: aktif durum tek istekte (delta/cursor bilincli yok — karar C)
  // ===========================================================================
  async snapshot(user: AuthUser) {
    const branchId = user.branchId;
    const [halls, tables, orders, categories, products] = await Promise.all([
      this.prisma.hall.findMany({
        where: { branchId, deletedAt: null, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.table.findMany({
        where: { branchId, deletedAt: null, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.order.findMany({
        where: {
          branchId,
          deletedAt: null,
          status: { in: [OrderStatus.Open, OrderStatus.Held] },
        },
        include: { items: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
        orderBy: { openedAt: 'asc' },
      }),
      this.prisma.category.findMany({
        where: { branchId, deletedAt: null, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.product.findMany({
        where: { branchId, deletedAt: null, isActive: true },
        include: { tax: { select: { ratePermille: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    // Katalog, /categories ve /products ile ayni gorunumde (QR menu JSON alanlari cozulmus).
    return {
      serverTime: new Date().toISOString(),
      halls,
      tables,
      orders,
      categories: categories.map(categoryView),
      products: products.map(productView),
    };
  }

  // ===========================================================================
  // Owner review (cakisan offline mutasyonlar)
  // ===========================================================================
  listReviews(user: AuthUser, status?: string) {
    return this.prisma.pendingOfflineReview.findMany({
      where: {
        branchId: user.branchId,
        status: status ?? OfflineReviewStatus.Open,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async resolveReview(user: AuthUser, id: string, dto: ResolveReviewDto) {
    const review = await this.prisma.pendingOfflineReview.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!review) {
      throw new NotFoundException({ code: 'REVIEW_NOT_FOUND', message: 'Review bulunamadi.' });
    }
    if (review.status !== OfflineReviewStatus.Open) {
      throw new ConflictException({
        code: 'REVIEW_ALREADY_RESOLVED',
        message: 'Review zaten sonuclandirilmis.',
      });
    }

    let result: MutationResult | null = null;
    if (dto.resolution !== 'reddet') {
      const mutation: SyncMutation = {
        clientOpId: review.clientOpId,
        type: review.mutationType as OfflineMutationType,
        payload: JSON.parse(review.mutationPayload) as Record<string, unknown>,
      };
      result = await this.applyResolution(user, review.deviceId, mutation, dto);
      if (
        result.status !== OfflineMutationResult.Applied &&
        result.status !== OfflineMutationResult.Duplicate
      ) {
        // Uygulanamadi -> review acik kalir, Owner nedenini gorur.
        throw new ConflictException({
          code: 'REVIEW_APPLY_FAILED',
          message: `Mutasyon uygulanamadi: ${result.reason ?? result.status}`,
        });
      }
      await this.prisma.processedClientOp.update({
        where: { clientOpId: review.clientOpId },
        data: {
          resultStatus: OfflineMutationResult.Applied,
          resultRef: result.serverId ?? null,
        },
      });
    }

    const updated = await this.prisma.pendingOfflineReview.update({
      where: { id },
      data: {
        status:
          dto.resolution === 'reddet' ? OfflineReviewStatus.Rejected : OfflineReviewStatus.Resolved,
        resolution: dto.resolution,
        resolvedBy: user.userId,
        resolvedAt: new Date(),
        version: { increment: 1 },
        syncState: 'pending',
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'sync.review.resolve',
      entityType: 'pending_offline_review',
      entityId: id,
      userId: user.userId,
      oldValue: review,
      newValue: { resolution: dto.resolution, result },
      clientOpId: review.clientOpId,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return { review: updated, result };
  }

  private async applyResolution(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
    dto: ResolveReviewDto,
  ): Promise<MutationResult> {
    if (dto.resolution === 'yeni_adisyon') {
      // Kalemleri tasiyacak yeni adisyon ac; mutasyon ona yonlendirilir.
      const order = await this.orders.openOrder(user, { tableId: dto.targetTableId ?? null });
      if (m.type === OfflineMutationType.OpenTable) {
        return {
          clientOpId: m.clientOpId,
          status: OfflineMutationResult.Applied,
          serverId: order!.id,
        };
      }
      m.payload = { ...m.payload, orderId: order!.id, orderClientOpId: undefined };
    } else {
      // yeniden_ac: kapali/iptal adisyonu tekrar acar, mutasyon uzerine uygulanir.
      const orderId = await this.resolveOrderId(user, m.payload);
      const order = await this.prisma.order.findFirst({
        where: { id: orderId, branchId: user.branchId, deletedAt: null },
      });
      if (!order) {
        throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadi.' });
      }
      if (order.status !== OrderStatus.Open) {
        if (order.status !== OrderStatus.Held || order.isPaid) {
          throw new ConflictException({
            code: 'ORDER_CANNOT_REOPEN',
            message: 'Odenmis veya iptal edilmis adisyon yeniden acilamaz; yeni adisyon kullanin.',
          });
        }
        if (order.tableId) {
          const occupied = await this.prisma.order.count({
            where: {
              branchId: user.branchId,
              tableId: order.tableId,
              id: { not: order.id },
              status: { in: [OrderStatus.Open, OrderStatus.Held] },
              deletedAt: null,
            },
          });
          if (occupied) {
            throw new ConflictException({
              code: 'TABLE_HAS_OPEN_ORDER',
              message: 'Masada baska bir aktif adisyon var.',
            });
          }
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: OrderStatus.Open,
              closedBy: null,
              closedAt: null,
              version: { increment: 1 },
              syncState: 'pending',
            },
          });
          if (order.tableId) {
            await tx.table.update({
              where: { id: order.tableId },
              data: {
                status: TableStatus.Occupied,
                version: { increment: 1 },
                syncState: 'pending',
              },
            });
          }
        });
      }
      m.payload = { ...m.payload, orderId, orderClientOpId: undefined };
    }
    return this.dispatch(user, deviceId, m);
  }

  // ===========================================================================
  // Dispatch: mutasyon -> mevcut domain servisleri
  // ===========================================================================
  private async dispatch(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
  ): Promise<MutationResult> {
    try {
      switch (m.type) {
        case OfflineMutationType.OpenTable:
          return await this.applyOpenTable(user, m);
        case OfflineMutationType.AddLine:
          return await this.applyAddLine(user, m);
        case OfflineMutationType.UpdateLineQty:
          return await this.applyUpdateLineQty(user, m);
        case OfflineMutationType.AddNote:
          return await this.applyAddNote(user, m);
        case OfflineMutationType.SubmitOrder:
          return await this.applySubmitOrder(user, m);
        default:
          // review kaydindan gelen tip dogrulanmamis olabilir
          return {
            clientOpId: m.clientOpId,
            status: OfflineMutationResult.Rejected,
            reason: 'UNSUPPORTED_TYPE',
          };
      }
    } catch (err) {
      return this.mapError(user, deviceId, m, err);
    }
  }

  private async applyOpenTable(user: AuthUser, m: SyncMutation): Promise<MutationResult> {
    const p = openTablePayload.parse(m.payload);
    try {
      const order = await this.orders.openOrder(user, {
        tableId: p.tableId ?? null,
        guestCount: p.guestCount,
        note: p.note,
        clientOpId: m.clientOpId,
      });
      return {
        clientOpId: m.clientOpId,
        status: OfflineMutationResult.Applied,
        serverId: order!.id,
      };
    } catch (err) {
      // Akilli birlestirme (K4): masada zaten acik adisyon var -> ona eklenir.
      if (this.errCode(err) === 'TABLE_HAS_OPEN_ORDER' && p.tableId) {
        const open = await this.prisma.order.findFirst({
          where: {
            branchId: user.branchId,
            tableId: p.tableId,
            status: OrderStatus.Open,
            deletedAt: null,
          },
        });
        if (open) {
          return {
            clientOpId: m.clientOpId,
            status: OfflineMutationResult.Applied,
            serverId: open.id,
          };
        }
      }
      throw err;
    }
  }

  private async applyAddLine(user: AuthUser, m: SyncMutation): Promise<MutationResult> {
    const p = addLinePayload.parse(m.payload);
    // Pasif urun offline'da satilamaz (K4 tablosu: rejected PRODUCT_INACTIVE).
    const product = await this.prisma.product.findFirst({
      where: { id: p.productId, branchId: user.branchId, deletedAt: null },
    });
    if (!product || !product.isActive) {
      return {
        clientOpId: m.clientOpId,
        status: OfflineMutationResult.Rejected,
        reason: 'PRODUCT_INACTIVE',
      };
    }
    const orderId = await this.resolveOrderId(user, p);
    await this.orders.addItem(user, orderId, {
      productId: p.productId,
      quantity: p.quantity,
      note: p.note,
      clientOpId: m.clientOpId,
    });
    const item = await this.prisma.orderItem.findUnique({ where: { clientOpId: m.clientOpId } });
    return {
      clientOpId: m.clientOpId,
      status: OfflineMutationResult.Applied,
      serverId: item?.id ?? orderId,
    };
  }

  private async applyUpdateLineQty(user: AuthUser, m: SyncMutation): Promise<MutationResult> {
    const p = updateLineQtyPayload.parse(m.payload);
    const item = await this.resolveItem(user, p);
    // Gonderilmis satirda artis istemci tarafinda yeni ADD_LINE'a cevrilir
    // (append delta); buraya yalniz pending satir duzenlemesi gelir.
    await this.orders.updateItem(user, item.orderId, item.id, { quantity: p.quantity });
    return { clientOpId: m.clientOpId, status: OfflineMutationResult.Applied, serverId: item.id };
  }

  private async applyAddNote(user: AuthUser, m: SyncMutation): Promise<MutationResult> {
    const p = addNotePayload.parse(m.payload);
    const item = await this.resolveItem(user, p);
    await this.prisma.orderItemNote.upsert({
      where: { clientOpId: m.clientOpId },
      update: {},
      create: {
        id: newId(),
        orderItemId: item.id,
        note: p.note,
        type: 'waiter',
        createdBy: user.userId,
        clientOpId: m.clientOpId,
        ...(user.deviceId ? { deviceId: user.deviceId } : {}),
      },
    });
    return { clientOpId: m.clientOpId, status: OfflineMutationResult.Applied, serverId: item.id };
  }

  private async applySubmitOrder(user: AuthUser, m: SyncMutation): Promise<MutationResult> {
    const p = submitOrderPayload.parse(m.payload);
    const orderId = await this.resolveOrderId(user, p);
    try {
      await this.orders.sendToKitchen(user, orderId);
    } catch (err) {
      // Replay'de kalemler zaten gonderilmis olabilir -> is yapilacak bir sey yok.
      if (this.errCode(err) !== 'NOTHING_TO_SEND') throw err;
    }
    return { clientOpId: m.clientOpId, status: OfflineMutationResult.Applied, serverId: orderId };
  }

  // ===========================================================================
  // Yardimcilar
  // ===========================================================================

  /** Adisyon referansini cozer: sunucu id > clientOpId'li order > defter kaydi (merge edilmis OPEN_TABLE). */
  private async resolveOrderId(
    user: AuthUser,
    ref: { orderId?: unknown; orderClientOpId?: unknown },
  ) {
    if (typeof ref.orderId === 'string' && ref.orderId) {
      const order = await this.prisma.order.findFirst({
        where: { id: ref.orderId, branchId: user.branchId, deletedAt: null },
        select: { id: true },
      });
      if (order) return order.id;
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadi.' });
    }
    const opId = typeof ref.orderClientOpId === 'string' ? ref.orderClientOpId : '';
    if (opId) {
      const byOp = await this.prisma.order.findFirst({
        where: { clientOpId: opId, branchId: user.branchId, deletedAt: null },
      });
      if (byOp) return byOp.id;
      const ledger = await this.prisma.processedClientOp.findUnique({
        where: { clientOpId: opId },
      });
      if (ledger?.branchId === user.branchId && ledger.resultRef) return ledger.resultRef;
    }
    throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadi.' });
  }

  private async resolveItem(
    user: AuthUser,
    ref: {
      itemId?: string | undefined;
      itemClientOpId?: string | undefined;
    },
  ) {
    const item = ref.itemId
      ? await this.prisma.orderItem.findFirst({
          where: {
            id: ref.itemId,
            deletedAt: null,
            order: { branchId: user.branchId, deletedAt: null },
          },
        })
      : await this.prisma.orderItem.findFirst({
          where: {
            clientOpId: ref.itemClientOpId!,
            deletedAt: null,
            order: { branchId: user.branchId, deletedAt: null },
          },
        });
    if (!item) {
      throw new NotFoundException({ code: 'ORDER_ITEM_NOT_FOUND', message: 'Kalem bulunamadi.' });
    }
    return item;
  }

  private errCode(err: unknown): string {
    const resp = (err as { getResponse?: () => unknown })?.getResponse?.();
    if (typeof resp !== 'object' || resp === null) return '';
    const code = (resp as Record<string, unknown>).code;
    return typeof code === 'string' ? code : '';
  }

  /** Hata -> mutasyon sonucu esleme (OFFLINE_DESIGN.md §8 tablosu). */
  private async mapError(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
    err: unknown,
  ): Promise<MutationResult> {
    if (err instanceof ZodError) {
      return {
        clientOpId: m.clientOpId,
        status: OfflineMutationResult.Rejected,
        reason: 'INVALID_PAYLOAD',
      };
    }
    const code = this.errCode(err);
    if (code === 'CASH_SESSION_REQUIRED') {
      return this.createReview(user, deviceId, m, OfflineReviewReason.CashClosed);
    }
    if (code === 'ORDER_NOT_OPEN') {
      return this.createReview(user, deviceId, m, OfflineReviewReason.TableClosed);
    }
    if (code === 'ORDER_NOT_FOUND' || code === 'TABLE_NOT_FOUND') {
      return this.createReview(user, deviceId, m, OfflineReviewReason.TableMoved);
    }
    if (code === 'PRODUCT_NOT_FOUND') {
      return {
        clientOpId: m.clientOpId,
        status: OfflineMutationResult.Rejected,
        reason: 'PRODUCT_INACTIVE',
      };
    }
    if (code) {
      return { clientOpId: m.clientOpId, status: OfflineMutationResult.Rejected, reason: code };
    }
    throw err; // beklenmeyen hata (DB vb.) -> 500, istemci tekrar dener
  }

  private async createReview(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
    reason: OfflineReviewReason,
  ): Promise<MutationResult> {
    const id = newId();
    await this.prisma.pendingOfflineReview.create({
      data: {
        id,
        branchId: user.branchId,
        deviceId,
        waiterId: user.userId,
        clientOpId: m.clientOpId,
        mutationType: m.type,
        mutationPayload: JSON.stringify(m.payload),
        reason,
      },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'sync.review.open',
      entityType: 'pending_offline_review',
      entityId: id,
      userId: user.userId,
      newValue: { clientOpId: m.clientOpId, mutationType: m.type, reason },
      origin: AuditOrigin.Offline,
      clientOpId: m.clientOpId,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return {
      clientOpId: m.clientOpId,
      status: OfflineMutationResult.Conflict,
      reviewId: id,
      reason,
    };
  }
}

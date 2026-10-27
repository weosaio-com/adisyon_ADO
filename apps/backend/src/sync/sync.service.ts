import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ZodError } from 'zod';
import { decodeTime } from 'ulid';
import {
  newId,
  AuditOrigin,
  OfflineMutationResult,
  OfflineMutationType,
  OfflineReviewReason,
  OfflineReviewStatus,
  OrderItemStatus,
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
import type {
  PushMutationsDto,
  ResolveGroupDto,
  ResolveReviewDto,
  SyncMutation,
} from './dto/sync.schemas';

/**
 * Cevrimdisi gorulen fiyat sunucudakinden farkli (OFF-3). Review nedeni metin kolon: paylasilan
 * OfflineReviewReason listesine dokunmadan yerel sabit.
 */
const PRICE_CHANGED = 'price_changed';
type ReviewReason = OfflineReviewReason | typeof PRICE_CHANGED;

/** Bir offline mutasyonun sunucu sonucu. OFFLINE_DESIGN.md §7.1 */
interface MutationResult {
  clientOpId: string;
  status: OfflineMutationResult;
  serverId?: string;
  reviewId?: string;
  reason?: string;
}

/** Oturum iptalinden (cikis) sonra olusturulmus sayilan kayda tanınan saat farki payi. */
const ACTOR_CLOCK_SLACK_MS = 10 * 60_000;

/** dispatch secenegi: review cozulurken cakisma yeni review acmaz, sonuc olarak doner. */
interface DispatchOptions {
  review: boolean;
}

interface ReviewRow {
  id: string;
  branchId: string;
  deviceId: string;
  waiterId: string;
  clientOpId: string;
  mutationType: string;
  mutationPayload: string;
  reason: string;
  status: string;
  createdAt: Date;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/**
 * Review'in ait oldugu siparis (grup anahtari): OPEN_TABLE kendi clientOpId'si; kalem / mutfaga
 * gonder / not, bagli oldugu OPEN_TABLE'in clientOpId'si ya da sunucu adisyon id'si. OFF-2
 */
export function reviewGroupKey(review: {
  clientOpId: string;
  mutationType: string;
  mutationPayload: string;
}): string {
  if (review.mutationType === OfflineMutationType.OpenTable) return `op:${review.clientOpId}`;
  const payload = parsePayload(review.mutationPayload);
  const op = str(payload.orderClientOpId);
  if (op) return `op:${op}`;
  const orderId = str(payload.orderId);
  return orderId ? `order:${orderId}` : `review:${review.clientOpId}`;
}

/**
 * Istemci-offline senkron cekirdegi (OFFLINE_DESIGN.md §7-9).
 * Mutasyonlar mevcut OrdersService uzerinden uygulanir -> online/offline ayni
 * kod yolu (karar E). Idempotency: ProcessedClientOp defteri + Order/OrderItem
 * uzerindeki unique clientOpId kolonlari (cift emniyet).
 * Cakisma: kapali/tasinan masa otomatik uygulanmaz -> PendingOfflineReview (K4).
 * Not: veritabani tek baglanti; bu servis `$transaction` icinde servis cagirmaz.
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
    const actors = new Map<string, AuthUser | null>();
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
      // Kaydi olusturan garson (dogrulanirsa) adina uygulanir; aksi halde gonderen adina.
      const actor = await this.mutationActor(user, dto.deviceId, m, actors);
      const r = await this.dispatch(actor, dto.deviceId, m);
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

  /**
   * Mutasyonu tablette olusturan kullanici (OFF-5). Ortak tablette A cevrimdisi siparis alip
   * cikis yapar, B girer: kayitlar B'nin oturumuyla gelir ama A'nin adina yazilmali. Kanit:
   * A'nin oturum kimligi (yalniz A'nin belirtecinde bulunur) A'ya ve ayni subeye ait olmali;
   * oturum iptal edildiyse (cikis) kayit iptalden once olusturulmus olmali. Dogrulanamazsa
   * kayit gonderen adina uygulanir (eski davranis). Aktarim denetim kaydina yazilir.
   */
  private async mutationActor(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
    cache: Map<string, AuthUser | null>,
  ): Promise<AuthUser> {
    const claim = m.actor;
    if (!claim || claim.userId === user.userId) return user;
    const key = `${claim.userId}:${claim.sessionId}`;
    if (!cache.has(key)) {
      const session = await this.prisma.session.findFirst({
        where: { id: claim.sessionId, userId: claim.userId, deletedAt: null },
        include: { user: { include: { role: { select: { name: true } } } } },
      });
      let opTime: number | null = null;
      try {
        opTime = decodeTime(m.clientOpId);
      } catch {
        opTime = null;
      }
      const valid =
        !!session &&
        session.user.branchId === user.branchId &&
        !session.user.deletedAt &&
        (!session.revokedAt ||
          (opTime !== null && opTime <= session.revokedAt.getTime() + ACTOR_CLOCK_SLACK_MS));
      const actor: AuthUser | null = valid
        ? {
            ...user,
            userId: session.userId,
            username: session.user.username,
            role: session.user.role.name,
            sessionId: session.id,
          }
        : null;
      cache.set(key, actor);
      await this.audit.record({
        branchId: user.branchId,
        action: valid ? 'sync.relay' : 'sync.relay.unverified',
        entityType: 'user',
        entityId: claim.userId,
        userId: user.userId,
        newValue: { actorId: claim.userId, sessionId: claim.sessionId, deviceId },
        origin: AuditOrigin.Offline,
        clientOpId: m.clientOpId,
      });
    }
    return cache.get(key) ?? user;
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
  // Owner review (cakisan offline mutasyonlar). OFF-2: karar siparis (grup) duzeyinde.
  // ===========================================================================

  /**
   * Acik review'lar + karti okunur kilan baglam: grup anahtari, garson, masa, asil adisyon,
   * urun adi ve fiyat farki. Ekran review'lari `context.groupKey` ile siparis kartlarina toplar.
   */
  async listReviews(user: AuthUser, status?: string) {
    const rows = await this.prisma.pendingOfflineReview.findMany({
      where: {
        branchId: user.branchId,
        status: status ?? OfflineReviewStatus.Open,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return [];
    const payloads = rows.map((row) => parsePayload(row.mutationPayload));
    const unique = (values: (string | undefined)[]) => [
      ...new Set(values.filter((v): v is string => !!v)),
    ];
    const opIds = unique(payloads.map((p) => str(p.orderClientOpId)));
    const ledger = opIds.length
      ? await this.prisma.processedClientOp.findMany({
          where: { branchId: user.branchId, clientOpId: { in: opIds } },
        })
      : [];
    const orderIdOfOp = new Map<string, string>();
    for (const row of ledger) {
      if (row.resultStatus === OfflineMutationResult.Applied && row.resultRef) {
        orderIdOfOp.set(row.clientOpId, row.resultRef);
      }
    }
    const byOpOrders = opIds.length
      ? await this.prisma.order.findMany({
          where: { branchId: user.branchId, clientOpId: { in: opIds }, deletedAt: null },
          select: { id: true, clientOpId: true },
        })
      : [];
    for (const order of byOpOrders)
      if (order.clientOpId) orderIdOfOp.set(order.clientOpId, order.id);
    const orderIdOf = (p: Record<string, unknown>) =>
      str(p.orderId) ?? orderIdOfOp.get(str(p.orderClientOpId) ?? '');

    const orderIds = unique(payloads.map(orderIdOf));
    const productIds = unique(payloads.map((p) => str(p.productId)));
    const [waiters, orders, products] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: unique(rows.map((row) => row.waiterId)) } },
        select: { id: true, displayName: true, username: true },
      }),
      orderIds.length
        ? this.prisma.order.findMany({
            where: { id: { in: orderIds }, branchId: user.branchId },
            select: { id: true, orderNo: true, status: true, tableId: true, isPaid: true },
          })
        : [],
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds }, branchId: user.branchId },
            select: { id: true, name: true, salePrice: true, isActive: true },
          })
        : [],
    ]);
    const tableIds = unique([
      ...payloads.map((p) => str(p.tableId)),
      ...orders.map((o) => o.tableId ?? undefined),
    ]);
    const tables = tableIds.length
      ? await this.prisma.table.findMany({
          where: { id: { in: tableIds }, branchId: user.branchId },
          select: { id: true, name: true },
        })
      : [];

    return rows.map((row, i) => {
      const p = payloads[i]!;
      const order = orders.find((o) => o.id === orderIdOf(p));
      const tableId = str(p.tableId) ?? order?.tableId ?? null;
      const product = products.find((x) => x.id === str(p.productId));
      const waiter = waiters.find((w) => w.id === row.waiterId);
      return {
        ...row,
        context: {
          groupKey: reviewGroupKey(row),
          waiterName: waiter?.displayName || waiter?.username || null,
          tableId,
          tableName: tables.find((t) => t.id === tableId)?.name ?? null,
          orderId: order?.id ?? null,
          orderNo: order?.orderNo ?? null,
          orderStatus: order?.status ?? null,
          // Yalniz bekletilen, odenmemis adisyon yeniden acilabilir.
          canReopen: order?.status === OrderStatus.Held && !order.isPaid,
          productName: product?.name ?? str(p.productName) ?? null,
          quantity: typeof p.quantity === 'number' ? p.quantity : null,
          seenPrice: typeof p.unitPrice === 'number' ? p.unitPrice : null,
          currentPrice: product?.salePrice ?? null,
          productActive: product ? product.isActive : null,
        },
      };
    });
  }

  /** Tek review (eski uc): siparis grubunun tek uyeli hali. */
  async resolveReview(user: AuthUser, id: string, dto: ResolveReviewDto) {
    const out = await this.resolveGroup(user, { reviewIds: [id], ...dto });
    return { review: out.reviews[0], result: out.results[0] ?? null };
  }

  /**
   * Bir siparisin review'larini tek kararla uygular (OFF-2): adisyon bir kez acilir (varsayilan
   * masa korunur; masa doluysa acik adisyonuna eklenir), kalemler sirayla eklenir, siparis
   * mutfaga gonderilmisse yalniz bu kalemler mutfaga gider. Uygulanamayan kalem review'i acik
   * kalir (Owner nedenini gorur); uygulananlar kapanir ve tablet sonucu ogrenir (OFF-8).
   */
  async resolveGroup(user: AuthUser, dto: ResolveGroupDto) {
    const ids = [...new Set(dto.reviewIds)];
    const reviews = (await this.prisma.pendingOfflineReview.findMany({
      where: { id: { in: ids }, branchId: user.branchId, deletedAt: null },
    })) as ReviewRow[];
    if (reviews.length !== ids.length) {
      throw new NotFoundException({ code: 'REVIEW_NOT_FOUND', message: 'Review bulunamadi.' });
    }
    if (reviews.some((r) => r.status !== OfflineReviewStatus.Open)) {
      throw new ConflictException({
        code: 'REVIEW_ALREADY_RESOLVED',
        message: 'Review zaten sonuclandirilmis.',
      });
    }
    // Tabletin gonderim sirasi: ayni cihazin clientOpId'leri artan (ULID).
    reviews.sort((a, b) =>
      a.clientOpId < b.clientOpId ? -1 : a.clientOpId > b.clientOpId ? 1 : 0,
    );

    if (dto.resolution === 'reddet') {
      const closed = [];
      for (const review of reviews) {
        closed.push(await this.closeReview(user, review, 'reddet', null));
      }
      return { reviews: closed, results: [] as MutationResult[], orderId: null, failed: [] };
    }

    const muts = reviews.map((review) => ({
      review,
      m: {
        clientOpId: review.clientOpId,
        type: review.mutationType as OfflineMutationType,
        // Onay = guncel fiyat kabul edildi: fiyat denetimi tekrar review acmasin.
        payload: { ...parsePayload(review.mutationPayload), unitPrice: undefined },
      } as SyncMutation,
    }));
    // Siparisi alan garsonun adina yazilir (satis/prim raporu); karari Owner verir (audit).
    const actor = await this.reviewActor(user, reviews[0]!.waiterId);
    const original = await this.originalOrder(
      user,
      muts.map((x) => x.m),
    );
    const orderId = await this.targetOrder(
      user,
      actor,
      muts.map((x) => x.m),
      original,
      dto,
    );

    const results: MutationResult[] = [];
    const closed = [];
    const failed: MutationResult[] = [];
    const itemIds: string[] = [];
    let submit = false;
    for (const { review, m } of muts) {
      let r: MutationResult;
      if (m.type === OfflineMutationType.OpenTable) {
        r = { clientOpId: m.clientOpId, status: OfflineMutationResult.Applied, serverId: orderId };
      } else if (m.type === OfflineMutationType.SubmitOrder) {
        submit = true;
        r = { clientOpId: m.clientOpId, status: OfflineMutationResult.Applied, serverId: orderId };
      } else {
        m.payload = { ...m.payload, orderId, orderClientOpId: undefined };
        r = await this.dispatch(actor, review.deviceId, m, { review: false });
        if (r.status === OfflineMutationResult.Applied && m.type === OfflineMutationType.AddLine) {
          if (r.serverId) itemIds.push(r.serverId);
        }
      }
      if (
        r.status === OfflineMutationResult.Applied ||
        r.status === OfflineMutationResult.Duplicate
      ) {
        results.push(r);
        closed.push(await this.closeReview(user, review, dto.resolution, r));
      } else {
        failed.push(r);
      }
    }
    // Siparis mutfaga gonderilmisti: grupta SUBMIT var ya da cihazin bu adisyon icin sonradan
    // uygulanan SUBMIT'i var (or. fiyat farki onayi). Yalniz bu kalemler gider (OFF-9).
    if (!submit && original && original.id === orderId) {
      const last = reviews[reviews.length - 1]!;
      submit = !!(await this.prisma.processedClientOp.findFirst({
        where: {
          branchId: user.branchId,
          deviceId: last.deviceId,
          mutationType: OfflineMutationType.SubmitOrder,
          resultStatus: OfflineMutationResult.Applied,
          resultRef: orderId,
          clientOpId: { gt: last.clientOpId },
        },
        select: { id: true },
      }));
    }
    if (submit && itemIds.length > 0) {
      try {
        await this.orders.sendToKitchen(actor, orderId, { itemIds });
      } catch (err) {
        if (this.errCode(err) !== 'NOTHING_TO_SEND') throw err;
      }
    }
    return { reviews: closed, results, orderId, failed };
  }

  /** Tabletin onaya dusen kayitlarinin sonucu: open | resolved (+ adisyon) | rejected. OFF-8 */
  async reviewStatus(user: AuthUser, clientOpIds: string[]) {
    const [reviews, ledger] = await Promise.all([
      this.prisma.pendingOfflineReview.findMany({
        where: { branchId: user.branchId, clientOpId: { in: clientOpIds }, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.processedClientOp.findMany({
        where: { branchId: user.branchId, clientOpId: { in: clientOpIds } },
      }),
    ]);
    const refs = ledger.map((row) => row.resultRef).filter((ref): ref is string => !!ref);
    const items = refs.length
      ? await this.prisma.orderItem.findMany({
          where: { id: { in: refs } },
          select: { id: true, orderId: true },
        })
      : [];
    return clientOpIds.map((clientOpId) => {
      const review = reviews.find((r) => r.clientOpId === clientOpId);
      if (!review) return { clientOpId, status: 'unknown' as const, orderId: null };
      const ref = ledger.find((row) => row.clientOpId === clientOpId)?.resultRef ?? null;
      const resolved = review.status === OfflineReviewStatus.Resolved;
      return {
        clientOpId,
        status: review.status,
        resolution: review.resolution,
        orderId: resolved ? (items.find((item) => item.id === ref)?.orderId ?? ref) : null,
      };
    });
  }

  /** Review'i kapatir, defteri sonuca gore gunceller (tekrarlar ayni sonucu alir), audit yazar. */
  private async closeReview(
    user: AuthUser,
    review: ReviewRow,
    resolution: string,
    result: MutationResult | null,
  ) {
    const rejected = resolution === 'reddet';
    await this.prisma.processedClientOp.updateMany({
      where: { clientOpId: review.clientOpId, branchId: user.branchId },
      data: rejected
        ? { resultStatus: OfflineMutationResult.Rejected }
        : { resultStatus: OfflineMutationResult.Applied, resultRef: result?.serverId ?? null },
    });
    const updated = await this.prisma.pendingOfflineReview.update({
      where: { id: review.id },
      data: {
        status: rejected ? OfflineReviewStatus.Rejected : OfflineReviewStatus.Resolved,
        resolution,
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
      entityId: review.id,
      userId: user.userId,
      oldValue: review,
      newValue: { resolution, result },
      clientOpId: review.clientOpId,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return updated;
  }

  /** Siparisi alan garson (aktif olmasa da): adisyon ve kalemler onun adina yazilir. */
  private async reviewActor(user: AuthUser, waiterId: string): Promise<AuthUser> {
    if (waiterId === user.userId) return user;
    const waiter = await this.prisma.user.findFirst({
      where: { id: waiterId, branchId: user.branchId },
      include: { role: { select: { name: true } } },
    });
    if (!waiter) return user;
    const { deviceId: _ownerDevice, ...rest } = user;
    return { ...rest, userId: waiter.id, username: waiter.username, role: waiter.role.name };
  }

  /** Grubun bagli oldugu sunucu adisyonu (varsa): orderId ya da OPEN_TABLE clientOpId'si. */
  private async originalOrder(user: AuthUser, muts: SyncMutation[]) {
    for (const m of muts) {
      if (m.type === OfflineMutationType.OpenTable) continue;
      const orderId = await this.resolveOrderId(user, m.payload).catch(() => null);
      if (!orderId) continue;
      return this.prisma.order.findFirst({
        where: { id: orderId, branchId: user.branchId, deletedAt: null },
        select: { id: true, status: true, tableId: true, isPaid: true },
      });
    }
    return null;
  }

  /**
   * Kalemlerin yazilacagi adisyon:
   * - yeniden_ac: bekletilen (odenmemis) asil adisyon yeniden acilir.
   * - uygula: asil adisyon aciksa o; degilse yeni adisyon gibi.
   * - yeni adisyon: hedef masa (verilmezse siparisin / asil adisyonun masasi); masa doluysa
   *   acik adisyonuna eklenir (masa basina tek adisyon), bossa garson adina yeni adisyon acilir.
   */
  private async targetOrder(
    user: AuthUser,
    actor: AuthUser,
    muts: SyncMutation[],
    original: { id: string; status: string; tableId: string | null; isPaid: boolean } | null,
    dto: ResolveGroupDto,
  ): Promise<string> {
    if (dto.resolution === 'yeniden_ac') {
      if (!original) {
        throw new NotFoundException({
          code: 'ORDER_NOT_FOUND',
          message: 'Asıl adisyon bulunamadı; yeni adisyon açın.',
        });
      }
      await this.reopenHeld(user, original);
      return original.id;
    }
    if (dto.resolution === 'uygula' && original?.status === OrderStatus.Open) return original.id;

    const open = muts.find((m) => m.type === OfflineMutationType.OpenTable);
    const openPayload = open ? openTablePayload.parse(open.payload) : null;
    const tableId =
      dto.targetTableId !== undefined
        ? dto.targetTableId
        : open
          ? (openPayload?.tableId ?? null)
          : (original?.tableId ?? null);
    if (tableId) {
      const active = await this.prisma.order.findFirst({
        where: {
          branchId: user.branchId,
          tableId,
          status: OrderStatus.Open,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (active) return active.id;
    }
    // OPEN_TABLE'in clientOpId'si korunur: tabletin sonraki kayitlari bu adisyonu bulur.
    const reuseOp =
      open && !(await this.prisma.order.findUnique({ where: { clientOpId: open.clientOpId } }));
    const order = await this.orders.openOrder(actor, {
      tableId,
      ...(openPayload?.guestCount ? { guestCount: openPayload.guestCount } : {}),
      ...(openPayload?.note ? { note: openPayload.note } : {}),
      ...(reuseOp ? { clientOpId: open.clientOpId } : {}),
    });
    return order!.id;
  }

  // Kapali/iptal adisyonu tekrar acar: yalniz bekletilen, odenmemis adisyon ve masasi bos ise.
  private async reopenHeld(
    user: AuthUser,
    order: { id: string; status: string; tableId: string | null; isPaid: boolean },
  ): Promise<void> {
    if (order.status === OrderStatus.Open) return;
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
        where: { id: order.id },
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
          data: { status: TableStatus.Occupied, version: { increment: 1 }, syncState: 'pending' },
        });
      }
    });
  }

  // ===========================================================================
  // Dispatch: mutasyon -> mevcut domain servisleri
  // ===========================================================================
  private async dispatch(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
    opts: DispatchOptions = { review: true },
  ): Promise<MutationResult> {
    try {
      switch (m.type) {
        case OfflineMutationType.OpenTable:
          return await this.applyOpenTable(user, m);
        case OfflineMutationType.AddLine:
          return await this.applyAddLine(user, deviceId, m, opts);
        case OfflineMutationType.UpdateLineQty:
          return await this.applyUpdateLineQty(user, m);
        case OfflineMutationType.AddNote:
          return await this.applyAddNote(user, m);
        case OfflineMutationType.SubmitOrder:
          return await this.applySubmitOrder(user, deviceId, m);
        default:
          // review kaydindan gelen tip dogrulanmamis olabilir
          return {
            clientOpId: m.clientOpId,
            status: OfflineMutationResult.Rejected,
            reason: 'UNSUPPORTED_TYPE',
          };
      }
    } catch (err) {
      return this.mapError(user, deviceId, m, err, opts);
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

  private async applyAddLine(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
    opts: DispatchOptions,
  ): Promise<MutationResult> {
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
    // Garsonun gordugu fiyat sunucudakinden farkli: musteriye soylenen tutar degismesin diye
    // kalem Owner onayina alinir (onayda guncel fiyatla eklenir ya da reddedilir).
    if (p.unitPrice !== undefined && p.unitPrice !== product.salePrice && opts.review) {
      return this.createReview(user, deviceId, m, PRICE_CHANGED);
    }
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

  /**
   * Mutfaga gonder: YALNIZ bu cihazin cevrimdisi ekledigi bekleyen kalemler gider (OFF-9).
   * Siparis baska tabletin acik adisyonuyla birlesmisse o garsonun henuz gondermedigi
   * (duzenlemekte oldugu) kalemler mutfaga gitmez.
   */
  private async applySubmitOrder(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
  ): Promise<MutationResult> {
    const p = submitOrderPayload.parse(m.payload);
    const orderId = await this.resolveOrderId(user, p);
    const pending = await this.prisma.orderItem.findMany({
      where: {
        orderId,
        status: OrderItemStatus.Pending,
        deletedAt: null,
        clientOpId: { not: null },
      },
      select: { id: true, clientOpId: true },
    });
    const mine = pending.length
      ? await this.prisma.processedClientOp.findMany({
          where: {
            branchId: user.branchId,
            deviceId,
            clientOpId: { in: pending.map((item) => item.clientOpId!) },
          },
          select: { clientOpId: true },
        })
      : [];
    const own = new Set(mine.map((row) => row.clientOpId));
    const itemIds = pending.filter((item) => own.has(item.clientOpId!)).map((item) => item.id);
    if (itemIds.length > 0) {
      try {
        await this.orders.sendToKitchen(user, orderId, { itemIds });
      } catch (err) {
        // Replay'de kalemler zaten gonderilmis olabilir -> is yapilacak bir sey yok.
        if (this.errCode(err) !== 'NOTHING_TO_SEND') throw err;
      }
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
      if (
        ledger?.branchId === user.branchId &&
        ledger.resultStatus === OfflineMutationResult.Applied &&
        ledger.resultRef
      ) {
        return ledger.resultRef;
      }
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

  /**
   * Adisyonu acamayan bagli kayit: OPEN_TABLE'i onaya dustuyse ayni nedenle (ayni siparis
   * grubunda) onaya alinir; reddedildiyse kayit da reddedilir. Yoksa null. OFF-2
   */
  private async rootCause(
    user: AuthUser,
    m: SyncMutation,
  ): Promise<{ status: 'conflict'; reason: ReviewReason } | { status: 'rejected' } | null> {
    const rootOp = str(m.payload.orderClientOpId);
    if (!rootOp || m.type === OfflineMutationType.OpenTable) return null;
    const ledger = await this.prisma.processedClientOp.findUnique({
      where: { clientOpId: rootOp },
    });
    if (!ledger || ledger.branchId !== user.branchId) return null;
    if (ledger.resultStatus === OfflineMutationResult.Rejected) return { status: 'rejected' };
    if (ledger.resultStatus !== OfflineMutationResult.Conflict) return null;
    const root = await this.prisma.pendingOfflineReview.findFirst({
      where: { clientOpId: rootOp, branchId: user.branchId, deletedAt: null },
      select: { reason: true, status: true },
    });
    if (root?.status === OfflineReviewStatus.Rejected) return { status: 'rejected' };
    return {
      status: 'conflict',
      reason: (root?.reason as ReviewReason) ?? OfflineReviewReason.Other,
    };
  }

  /** Hata -> mutasyon sonucu esleme (OFFLINE_DESIGN.md §8 tablosu). */
  private async mapError(
    user: AuthUser,
    deviceId: string,
    m: SyncMutation,
    err: unknown,
    opts: DispatchOptions,
  ): Promise<MutationResult> {
    if (err instanceof ZodError) {
      return {
        clientOpId: m.clientOpId,
        status: OfflineMutationResult.Rejected,
        reason: 'INVALID_PAYLOAD',
      };
    }
    const code = this.errCode(err);
    // Review cozulurken: cakisma yeni review acmaz; Owner nedeni sonuc olarak gorur.
    const review = async (reason: ReviewReason): Promise<MutationResult> =>
      opts.review
        ? this.createReview(user, deviceId, m, reason)
        : {
            clientOpId: m.clientOpId,
            status: OfflineMutationResult.Rejected,
            reason: code || reason,
          };
    if (code === 'CASH_SESSION_REQUIRED') return review(OfflineReviewReason.CashClosed);
    if (code === 'ORDER_NOT_OPEN') return review(OfflineReviewReason.TableClosed);
    if (code === 'ORDER_NOT_FOUND' || code === 'TABLE_NOT_FOUND') {
      const root = await this.rootCause(user, m);
      if (root?.status === 'rejected') {
        return {
          clientOpId: m.clientOpId,
          status: OfflineMutationResult.Rejected,
          reason: 'ORDER_NOT_OPENED',
        };
      }
      return review(root?.reason ?? OfflineReviewReason.TableMoved);
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
    reason: ReviewReason,
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

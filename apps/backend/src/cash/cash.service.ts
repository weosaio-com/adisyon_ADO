import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DURABLE_LISTENER } from '../common/events/durable-listener';
import { Prisma } from '@prisma/client';
import { newId, CashTxnType, OrderStatus, type DomainEvent } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { OpenSessionDto, CloseSessionDto, CreateCashTransactionDto } from './dto/cash.schemas';
import { businessDayOf } from '../reports/reports.calc';

@Injectable()
export class CashService {
  private readonly logger = new Logger(CashService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Cash Session Management
  // ===========================================================================
  async openSession(user: AuthUser, dto: OpenSessionDto) {
    const existing = await this.prisma.cashSession.findFirst({
      where: { branchId: user.branchId, status: 'open', deletedAt: null },
    });
    if (existing) {
      throw new ConflictException('Zaten açık bir kasa oturumu mevcut.');
    }

    const id = newId();
    // İş günü (06:00 kuralı, LOCAL tarih) — reports.calc ile ayni tanim.
    const now = new Date();
    const businessDay = businessDayOf(now);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const session = await tx.cashSession.create({
          data: {
            id,
            branchId: user.branchId,
            sessionDevice: user.deviceId || 'main-terminal',
            openedBy: user.userId,
            openedAt: now,
            openingFloat: dto.openingFloat,
            status: 'open',
            businessDay,
          },
        });

        // Açılış işlemi için kasa hareketi kaydı (Opening transaction)
        await tx.cashTransaction.create({
          data: {
            id: newId(),
            cashSessionId: id,
            type: CashTxnType.Opening,
            amount: dto.openingFloat,
            method: 'cash',
            createdBy: user.userId,
            note: 'Kasa açılış bakiyesi',
          },
        });

        return session;
      });
    } catch (e) {
      // Yaris: iki es zamanli acilis da findFirst'u gecebilir; ikincisi
      // uq_cash_sessions_one_open index'ine takilir -> ayni dostane hata.
      // (Sema-disi raw index'te Prisma P2002 yerine ham SQLite hatasi da verebilir.)
      const unique =
        (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') ||
        /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : '');
      if (unique) {
        throw new ConflictException('Zaten açık bir kasa oturumu mevcut.');
      }
      throw e;
    }
  }

  async closeSession(user: AuthUser, dto: CloseSessionDto) {
    const session = await this.prisma.cashSession.findFirst({
      where: { branchId: user.branchId, status: 'open', deletedAt: null },
    });
    if (!session) {
      throw new NotFoundException('Açık kasa oturumu bulunamadı.');
    }

    return this.prisma.$transaction(async (tx) => {
      const openOrderCount = await tx.order.count({
        where: {
          branchId: user.branchId,
          status: { in: [OrderStatus.Open, OrderStatus.Held] },
          deletedAt: null,
        },
      });
      if (openOrderCount > 0) {
        throw new ConflictException({
          code: 'OPEN_ORDERS_EXIST',
          message: `${openOrderCount} açık veya bekleyen adisyon varken kasa kapatılamaz.`,
        });
      }

      // Beklenen tutar = Kasa açılış + tüm hareketler
      const txs = await tx.cashTransaction.findMany({
        where: { cashSessionId: session.id, deletedAt: null },
      });

      const totalTransactions = txs.reduce((sum, t) => {
        // Açılış hareketi zaten dahildir. Diğerlerini de topla.
        if (t.type === CashTxnType.Opening) return sum;
        return sum + t.amount;
      }, 0);

      const expectedAmount = session.openingFloat + totalTransactions;
      const difference = dto.countedAmount - expectedAmount;

      // Kapanış hareketi ekle
      await tx.cashTransaction.create({
        data: {
          id: newId(),
          cashSessionId: session.id,
          type: CashTxnType.Closing,
          amount: dto.countedAmount,
          method: 'cash',
          createdBy: user.userId,
          note: `Kasa kapanış sayımı. Fark: ${difference / 100} TL`,
        },
      });

      const closed = await tx.cashSession.updateMany({
        where: { id: session.id, status: 'open', version: session.version },
        data: {
          status: 'closed',
          closedAt: new Date(),
          closedBy: user.userId,
          countedAmount: dto.countedAmount,
          expectedAmount,
          difference,
          version: { increment: 1 },
        },
      });
      if (closed.count !== 1) {
        throw new ConflictException('Kasa oturumu es zamanli olarak kapatildi.');
      }
      return tx.cashSession.findUniqueOrThrow({ where: { id: session.id } });
    });
  }

  async getActiveSession(user: AuthUser) {
    const session = await this.prisma.cashSession.findFirst({
      where: { branchId: user.branchId, status: 'open', deletedAt: null },
      include: {
        transactions: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!session) throw new NotFoundException('Aktif kasa oturumu bulunamadı.');
    return session;
  }

  async getStatus(user: AuthUser) {
    const session = await this.prisma.cashSession.findFirst({
      where: { branchId: user.branchId, status: 'open', deletedAt: null },
      select: { openedAt: true },
    });
    return { open: Boolean(session), openedAt: session?.openedAt ?? null };
  }

  // ===========================================================================
  // Cash Transactions
  // ===========================================================================
  async createTransaction(user: AuthUser, dto: CreateCashTransactionDto) {
    const session = await this.prisma.cashSession.findFirst({
      where: { branchId: user.branchId, status: 'open', deletedAt: null },
    });
    if (!session) {
      throw new ConflictException('İşlem yapabilmek için önce kasa oturumu açmalısınız.');
    }

    return this.prisma.cashTransaction.create({
      data: {
        id: newId(),
        cashSessionId: session.id,
        type: dto.type,
        amount: dto.amount,
        method: dto.method,
        createdBy: user.userId,
        note: dto.note ?? null,
      },
    });
  }

  // ===========================================================================
  // Domain Event Listener
  // ===========================================================================
  @OnEvent('order.paid', DURABLE_LISTENER)
  async handleOrderPaid(
    event: DomainEvent<'order.paid', { amount: number; method: string; paymentId: string }>,
  ) {
    const { amount, method, paymentId } = event.payload;
    // Yalnizca nakit odeme kasa cekmecesine girer; kart/havale/qr/veresiye girmez
    // (aksi halde kapanis sayiminda beklenen tutar sismis olur).
    if (method !== 'cash') return;
    if (
      await this.prisma.cashTransaction.findUnique({
        where: { relatedPaymentId: paymentId },
      })
    ) {
      return;
    }
    this.logger.log(
      `Received order.paid event. Logging cash transaction for payment: ${paymentId}`,
    );

    const session = await this.prisma.cashSession.findFirst({
      where: { branchId: event.branchId, status: 'open', deletedAt: null },
    });

    if (!session) {
      this.logger.warn(
        `Received order.paid event but no active CashSession found for branch ${event.branchId}`,
      );
      return;
    }

    await this.prisma.cashTransaction.create({
      data: {
        id: newId(),
        cashSessionId: session.id,
        type: CashTxnType.Sale,
        amount,
        method,
        relatedPaymentId: paymentId,
        createdBy: event.actorId || 'system',
        note: `Sipariş satışı (Ödeme Ref: ${paymentId})`,
      },
    });
  }

  @OnEvent('order.refunded', DURABLE_LISTENER)
  async handleOrderRefunded(
    event: DomainEvent<'order.refunded', { amount: number; method: string; paymentId: string }>,
  ) {
    const { amount, method, paymentId } = event.payload;
    // Yalnizca nakit iade cekmeceden cikar (kart/havale/veresiye cekmeceyi etkilemez).
    if (method !== 'cash') return;
    if (
      await this.prisma.cashTransaction.findUnique({
        where: { relatedPaymentId: paymentId },
      })
    ) {
      return;
    }

    const session = await this.prisma.cashSession.findFirst({
      where: { branchId: event.branchId, status: 'open', deletedAt: null },
    });
    if (!session) {
      this.logger.warn(
        `Received order.refunded but no active CashSession found for branch ${event.branchId}`,
      );
      return;
    }

    await this.prisma.cashTransaction.create({
      data: {
        id: newId(),
        cashSessionId: session.id,
        type: CashTxnType.Refund,
        amount: -amount, // cekmeceden cikis -> kapanis beklenen tutarini azaltir
        method: 'cash',
        relatedPaymentId: paymentId,
        createdBy: event.actorId || 'system',
        note: `İade (Ödeme Ref: ${paymentId})`,
      },
    });
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  newId,
  createDomainEvent,
  DomainEventName,
  OrderStatus,
  PaymentDirection,
  PaymentMethod,
  CashTxnType,
  DebtTxnType,
  TableStatus,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EventBusService } from '../common/events/event-bus.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { RecordPaymentDto, ReversePaymentDto } from './dto/payments.schemas';
import { allocatePayment, settlePayment } from './payments.calc';
import { formatTl } from './money-limits';

/**
 * Odeme modulu (PR3): adisyona odeme al (append-only, cift-cekim idempotent),
 * nakit para ustu, split/kismi odeme (toplam >= grandTotal olunca kapanis),
 * masayi bosalt, `order.paid` yayinla (kasa/veresiye/yazdirma dinler).
 *
 * Okuma+dogrulama+yazma TEK transaction: kismi odemede iki es zamanli istegin
 * ayni bakiyeyi gorup fazla-odeme yapmasi (race) engellenir.
 *
 * KAPSAM DISI (sonraki PR): iade/reversal (sema destekler), adisyon indirim.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {}

  private provenance(user: AuthUser): { deviceId?: string } {
    return user.deviceId ? { deviceId: user.deviceId } : {};
  }

  async recordPayment(user: AuthUser, orderId: string, dto: RecordPaymentDto) {
    const dup = await this.prisma.payment.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      include: { order: { select: { branchId: true } } },
    });
    if (dup) {
      if (dup.orderId !== orderId || dup.order.branchId !== user.branchId) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Bu islem anahtari baska bir odemede kullanilmis.',
        });
      }
      return this.orderWithPayments(user.branchId, orderId);
    }

    const paymentId = newId();
    let payment;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, branchId: user.branchId, deletedAt: null },
        });
        if (!order) {
          throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadi.' });
        }
        if (order.status !== OrderStatus.Open) {
          throw new ConflictException({ code: 'ORDER_NOT_OPEN', message: 'Adisyon acik degil.' });
        }

        const totals = await tx.payment.groupBy({
          by: ['direction'],
          where: { orderId, deletedAt: null },
          _sum: { amount: true },
        });
        const totalOf = (direction: string) =>
          totals.find((row) => row.direction === direction)?._sum.amount ?? 0;
        const alreadyPaid = totalOf(PaymentDirection.Charge) - totalOf(PaymentDirection.Refund);
        const remaining = order.grandTotal - alreadyPaid;
        if (remaining <= 0) {
          throw new ConflictException({
            code: 'ORDER_ALREADY_PAID',
            message: 'Adisyon zaten tamamen odendi.',
          });
        }
        // Kalandan fazla tutar: nakitte fazlasi para ustu (adisyona ve kasaya yalniz kalan
        // yazilir); kart/havale/QR/veresiyede fazla tahsilat reddedilir (allowOverpay artik
        // etkisiz: fazla tutar satis gibi kasaya ve Z raporuna giriyordu).
        const allocated = allocatePayment({
          remaining,
          amount: dto.amount,
          method: dto.method,
          ...(dto.received !== undefined ? { received: dto.received } : {}),
        });
        if (!allocated) {
          throw new BadRequestException({
            code: 'BILL_OVERPAY',
            message: `Kalan tutardan (${formatTl(remaining)}) fazla tahsil edilemez; fazlası yalnız nakitte para üstü olarak verilir.`,
          });
        }
        const amount = allocated.amount;

        const { received, change, fullyPaid } = settlePayment({
          grandTotal: order.grandTotal,
          alreadyPaid,
          amount,
          method: dto.method,
          ...(allocated.received !== undefined ? { received: allocated.received } : {}),
        });

        const debtAccount =
          dto.method === PaymentMethod.Debt
            ? await tx.debtAccount.findFirst({
                where: {
                  customerId: dto.customerId!,
                  deletedAt: null,
                  customer: {
                    branchId: user.branchId,
                    deletedAt: null,
                    isActive: true,
                  },
                },
              })
            : null;
        if (dto.method === PaymentMethod.Debt && !debtAccount) {
          throw new NotFoundException({
            code: 'CUSTOMER_NOT_FOUND',
            message: 'Musteri veya veresiye hesabi bulunamadi.',
          });
        }
        const cashSession =
          dto.method === PaymentMethod.Cash
            ? await tx.cashSession.findFirst({
                where: { branchId: user.branchId, status: 'open', deletedAt: null },
              })
            : null;
        if (dto.method === PaymentMethod.Cash && !cashSession) {
          throw new ConflictException({
            code: 'CASH_SESSION_REQUIRED',
            message: 'Nakit odeme icin once kasa oturumu acmalisiniz.',
          });
        }

        const p = await tx.payment.create({
          data: {
            id: paymentId,
            orderId,
            method: dto.method,
            direction: PaymentDirection.Charge,
            amount,
            received,
            change,
            reference: dto.reference ?? null,
            customerId: dto.customerId ?? null,
            takenBy: user.userId,
            paidAt: new Date(),
            idempotencyKey: dto.idempotencyKey,
            ...this.provenance(user),
          },
        });

        const orderUpdate = await tx.order.updateMany({
          where: { id: orderId, version: order.version, status: OrderStatus.Open },
          data: fullyPaid
            ? {
                isPaid: true,
                status: OrderStatus.Completed,
                closedBy: user.userId,
                closedAt: new Date(),
                completedAt: order.completedAt ?? new Date(),
                version: { increment: 1 },
                syncState: 'pending',
              }
            : {
                version: { increment: 1 },
                syncState: 'pending',
              },
        });
        if (orderUpdate.count !== 1) {
          throw new ConflictException({
            code: 'ORDER_CHANGED',
            message: 'Adisyon es zamanli olarak degisti. Lutfen tekrar deneyin.',
          });
        }

        if (cashSession) {
          await tx.cashTransaction.create({
            data: {
              id: newId(),
              cashSessionId: cashSession.id,
              type: CashTxnType.Sale,
              amount,
              method: dto.method,
              relatedPaymentId: paymentId,
              createdBy: user.userId,
              note: `Siparis satisi (Odeme Ref: ${paymentId})`,
              ...this.provenance(user),
            },
          });
        }

        if (debtAccount) {
          await tx.debtTransaction.create({
            data: {
              id: newId(),
              debtAccountId: debtAccount.id,
              type: DebtTxnType.DebtAdd,
              amount,
              relatedOrderId: orderId,
              relatedPaymentId: paymentId,
              createdBy: user.userId,
              note: `Adisyon borc kaydi (Ref No: ${orderId})`,
              occurredAt: new Date(),
              ...this.provenance(user),
            },
          });
          await tx.debtAccount.update({
            where: { id: debtAccount.id },
            data: { balance: { increment: amount }, version: { increment: 1 } },
          });
        }

        if (fullyPaid) {
          // Baska acik adisyon yoksa masayi bosalt (split adisyon guvenligi).
          if (order.tableId) {
            const stillOpen = await tx.order.count({
              where: {
                branchId: user.branchId,
                tableId: order.tableId,
                status: OrderStatus.Open,
                deletedAt: null,
              },
            });
            if (stillOpen === 0) {
              await tx.table.update({
                where: { id: order.tableId },
                data: {
                  status: TableStatus.Empty,
                  version: { increment: 1 },
                  syncState: 'pending',
                },
              });
            }
          }
        }
        await this.events.publishDurable(
          tx,
          createDomainEvent(
            DomainEventName.OrderPaid,
            {
              orderId,
              paymentId,
              amount,
              method: dto.method,
              ...(dto.customerId ? { customerId: dto.customerId } : {}),
            },
            {
              branchId: user.branchId,
              actorId: user.userId,
              ...(user.deviceId ? { deviceId: user.deviceId } : {}),
            },
          ),
        );
        return p;
      });
    } catch (e) {
      // Yaris: ayni idempotencyKey araya girdi -> idempotent don.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.payment.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: { order: { select: { branchId: true } } },
        });
        if (existing?.orderId === orderId && existing.order.branchId === user.branchId) {
          return this.orderWithPayments(user.branchId, orderId);
        }
      }
      throw e;
    }

    await this.audit.record({
      branchId: user.branchId,
      action: 'payment.take',
      entityType: 'payment',
      entityId: paymentId,
      userId: user.userId,
      newValue: payment,
      ...this.provenance(user),
    });

    return this.orderWithPayments(user.branchId, orderId);
  }

  async reversePayment(user: AuthUser, orderId: string, paymentId: string, dto: ReversePaymentDto) {
    const dup = await this.prisma.payment.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
      include: { order: { select: { branchId: true } } },
    });
    if (dup) {
      if (dup.orderId !== orderId || dup.order.branchId !== user.branchId) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Bu islem anahtari baska bir odemede kullanilmis.',
        });
      }
      return this.orderWithPayments(user.branchId, orderId);
    }

    const refundId = newId();
    let refund;
    try {
      refund = await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, branchId: user.branchId, deletedAt: null },
        });
        if (!order) {
          throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Adisyon bulunamadi.' });
        }

        const original = await tx.payment.findFirst({
          where: { id: paymentId, orderId, direction: PaymentDirection.Charge, deletedAt: null },
        });
        if (!original) {
          throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Odeme bulunamadi.' });
        }

        const alreadyReversed = await tx.payment.findFirst({
          where: { reversesPaymentId: paymentId, deletedAt: null },
        });
        if (alreadyReversed) {
          throw new ConflictException({
            code: 'PAYMENT_ALREADY_REVERSED',
            message: 'Bu odeme zaten iade edilmis.',
          });
        }
        if (dto.customerId && original.customerId && dto.customerId !== original.customerId) {
          throw new ConflictException({
            code: 'PAYMENT_CUSTOMER_MISMATCH',
            message: 'Iade musterisi odemenin musterisiyle eslesmiyor.',
          });
        }
        const customerId = original.customerId ?? dto.customerId;
        if (original.method === PaymentMethod.Debt && !customerId) {
          throw new BadRequestException({
            code: 'CUSTOMER_REQUIRED',
            message: 'Eski veresiye odemesinin iadesi icin customerId zorunlu.',
          });
        }
        const debtAccount =
          original.method === PaymentMethod.Debt
            ? await tx.debtAccount.findFirst({
                where: {
                  customerId: customerId!,
                  deletedAt: null,
                  customer: { branchId: user.branchId, deletedAt: null },
                },
              })
            : null;
        if (original.method === PaymentMethod.Debt && !debtAccount) {
          throw new NotFoundException({
            code: 'CUSTOMER_NOT_FOUND',
            message: 'Musteri veya veresiye hesabi bulunamadi.',
          });
        }
        const cashSession =
          original.method === PaymentMethod.Cash
            ? await tx.cashSession.findFirst({
                where: { branchId: user.branchId, status: 'open', deletedAt: null },
              })
            : null;
        if (original.method === PaymentMethod.Cash && !cashSession) {
          throw new ConflictException({
            code: 'CASH_SESSION_REQUIRED',
            message: 'Nakit iade icin once kasa oturumu acmalisiniz.',
          });
        }

        // Ters kayit (append-only): orijinali degistirmeyiz, telafi kaydi ekleriz.
        const refundPayment = await tx.payment.create({
          data: {
            id: refundId,
            orderId,
            method: original.method,
            direction: PaymentDirection.Refund,
            amount: original.amount,
            received: 0,
            change: 0,
            reference: dto.reason ?? null,
            customerId: customerId ?? null,
            takenBy: user.userId,
            paidAt: new Date(),
            reversesPaymentId: original.id,
            idempotencyKey: dto.idempotencyKey,
            ...this.provenance(user),
          },
        });

        if (cashSession) {
          await tx.cashTransaction.create({
            data: {
              id: newId(),
              cashSessionId: cashSession.id,
              type: CashTxnType.Refund,
              amount: -original.amount,
              method: PaymentMethod.Cash,
              relatedPaymentId: refundId,
              createdBy: user.userId,
              note: `Iade (Odeme Ref: ${refundId})`,
              ...this.provenance(user),
            },
          });
        }

        if (debtAccount) {
          await tx.debtTransaction.create({
            data: {
              id: newId(),
              debtAccountId: debtAccount.id,
              type: DebtTxnType.Payment,
              amount: -original.amount,
              relatedOrderId: orderId,
              relatedPaymentId: refundId,
              createdBy: user.userId,
              note: `Adisyon iadesi - borc geri alma (Ref No: ${orderId})`,
              occurredAt: new Date(),
              ...this.provenance(user),
            },
          });
          await tx.debtAccount.update({
            where: { id: debtAccount.id },
            data: { balance: { decrement: original.amount }, version: { increment: 1 } },
          });
        }

        // Kalan odeme = charge toplami - refund toplami. Adisyon kapaliyken
        // tam odemenin altina duserse yeniden acilir (duzeltme mumkun olsun).
        const charges = await tx.payment.aggregate({
          where: { orderId, direction: PaymentDirection.Charge, deletedAt: null },
          _sum: { amount: true },
        });
        const refunds = await tx.payment.aggregate({
          where: { orderId, direction: PaymentDirection.Refund, deletedAt: null },
          _sum: { amount: true },
        });
        const netPaid = (charges._sum.amount ?? 0) - (refunds._sum.amount ?? 0);

        if (order.isPaid && netPaid < order.grandTotal) {
          const reopened = await tx.order.updateMany({
            where: { id: orderId, version: order.version },
            data: {
              isPaid: false,
              status: OrderStatus.Open,
              closedBy: null,
              closedAt: null,
              version: { increment: 1 },
              syncState: 'pending',
            },
          });
          if (reopened.count !== 1) {
            throw new ConflictException({
              code: 'ORDER_CHANGED',
              message: 'Adisyon es zamanli olarak degisti. Lutfen tekrar deneyin.',
            });
          }
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
        }
        await this.events.publishDurable(
          tx,
          createDomainEvent(
            DomainEventName.OrderRefunded,
            {
              orderId,
              paymentId: refundId,
              originalPaymentId: paymentId,
              amount: refundPayment.amount,
              method: refundPayment.method,
              ...(refundPayment.customerId ? { customerId: refundPayment.customerId } : {}),
            },
            {
              branchId: user.branchId,
              actorId: user.userId,
              ...(user.deviceId ? { deviceId: user.deviceId } : {}),
            },
          ),
        );
        return refundPayment;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.payment.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: { order: { select: { branchId: true } } },
        });
        if (existing?.orderId === orderId && existing.order.branchId === user.branchId) {
          return this.orderWithPayments(user.branchId, orderId);
        }
        const reversal = await this.prisma.payment.findUnique({
          where: { reversesPaymentId: paymentId },
        });
        if (reversal) {
          throw new ConflictException({
            code: 'PAYMENT_ALREADY_REVERSED',
            message: 'Bu odeme zaten iade edilmis.',
          });
        }
      }
      throw e;
    }

    await this.audit.record({
      branchId: user.branchId,
      action: 'payment.refund',
      entityType: 'payment',
      entityId: refundId,
      userId: user.userId,
      newValue: refund,
      ...(dto.reason ? { reason: dto.reason } : {}),
      ...this.provenance(user),
    });

    return this.orderWithPayments(user.branchId, orderId);
  }

  listPayments(user: AuthUser, orderId: string) {
    return this.prisma.payment.findMany({
      where: { orderId, order: { branchId: user.branchId }, deletedAt: null },
      orderBy: { paidAt: 'asc' },
    });
  }

  private async orderWithPayments(branchId: string, orderId: string) {
    return this.prisma.order.findFirst({
      where: { id: orderId, branchId, deletedAt: null },
      include: {
        items: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
        payments: { where: { deletedAt: null }, orderBy: { paidAt: 'asc' } },
      },
    });
  }
}

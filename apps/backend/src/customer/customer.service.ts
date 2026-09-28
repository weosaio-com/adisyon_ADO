import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DURABLE_LISTENER } from '../common/events/durable-listener';
import { newId, DebtTxnType, CashTxnType, type DomainEvent } from '@ado/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type {
  CreateCustomerDto,
  UpdateCustomerDto,
  AddDebtDto,
  PayDebtDto,
} from './dto/customer.schemas';

@Injectable()
export class CustomerService {
  private readonly logger = new Logger(CustomerService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Customer CRUD
  // ===========================================================================
  async createCustomer(user: AuthUser, dto: CreateCustomerDto) {
    const id = newId();
    const accountId = newId();

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          id,
          branchId: user.branchId,
          name: dto.name,
          phone: dto.phone ?? null,
          address: dto.address ?? null,
          taxNo: dto.taxNo ?? null,
          nationalId: dto.nationalId ?? null,
          note: dto.note ?? null,
          deviceId: user.deviceId ?? null,
        },
      });

      // Veresiye borç hesabı aç (Debt account)
      await tx.debtAccount.create({
        data: {
          id: accountId,
          customerId: id,
          balance: 0,
          currency: 'TRY',
          deviceId: user.deviceId ?? null,
        },
      });

      return customer;
    });
  }

  async updateCustomer(user: AuthUser, id: string, dto: UpdateCustomerDto) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!customer) throw new NotFoundException('Müşteri bulunamadı.');

    const data: Prisma.CustomerUpdateInput = {
      version: { increment: 1 },
    };
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.taxNo !== undefined) data.taxNo = dto.taxNo;
    if (dto.nationalId !== undefined) data.nationalId = dto.nationalId;
    if (dto.note !== undefined) data.note = dto.note;

    return this.prisma.customer.update({
      where: { id },
      data,
    });
  }

  async deleteCustomer(user: AuthUser, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
      include: { debtAccount: true },
    });
    if (!customer) throw new NotFoundException('Müşteri bulunamadı.');
    // Bakiyesi olan musteri silinirse borc raporlardan kaybolur -> engelle.
    if (customer.debtAccount && customer.debtAccount.balance !== 0) {
      throw new ConflictException({
        code: 'CUSTOMER_HAS_BALANCE',
        message: 'Bakiyesi sıfır olmayan müşteri silinemez. Önce hesabı kapatın.',
      });
    }

    await this.prisma.customer.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });
    return { success: true };
  }

  async listCustomers(user: AuthUser) {
    return this.prisma.customer.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      include: { debtAccount: true },
      orderBy: { name: 'asc' },
    });
  }

  async getCustomer(user: AuthUser, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
      include: {
        debtAccount: {
          include: {
            transactions: {
              where: { deletedAt: null },
              orderBy: { occurredAt: 'desc' },
            },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException('Müşteri bulunamadı.');
    return customer;
  }

  // Veresiye ekstresi (CSV). ponytail: PDF motoru yeni bagimlilik -> eklenmedi;
  // CSV zero-dep, Excel/muhasebe icin yeterli. PDF/termal render sunum katmani isi.
  // Yuruyen bakiye hareketlerden kronolojik (asc) hesaplanir (kaynak = hareketler).
  async getStatementCsv(user: AuthUser, id: string): Promise<{ filename: string; csv: string }> {
    const customer = await this.getCustomer(user, id); // yoksa 404
    const txns = [...(customer.debtAccount?.transactions ?? [])].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const tl = (kurus: number) => (kurus / 100).toFixed(2);
    const rows: string[] = [['Tarih', 'Islem', 'Tutar (TL)', 'Bakiye (TL)', 'Not'].join(';')];
    let balance = 0;
    for (const t of txns) {
      balance += t.amount;
      const label = t.type === 'payment' ? 'Tahsilat' : 'Borc';
      rows.push(
        [
          esc(t.occurredAt.toISOString()),
          esc(label),
          tl(t.amount),
          tl(balance),
          esc(t.note ?? ''),
        ].join(';'),
      );
    }
    rows.push('');
    rows.push([esc('Musteri'), esc(customer.name)].join(';'));
    rows.push([esc('Guncel Bakiye (TL)'), tl(customer.debtAccount?.balance ?? balance)].join(';'));
    // BOM + CRLF -> Excel Turkce karakter ve satir sonu uyumu.
    return { filename: `ekstre-${id}.csv`, csv: '﻿' + rows.join('\r\n') };
  }

  // ===========================================================================
  // Veresiye Borç & Tahsilat İşlemleri
  // ===========================================================================
  async addDebt(user: AuthUser, customerId: string, dto: AddDebtDto) {
    const account = await this.prisma.debtAccount.findFirst({
      where: {
        customerId,
        deletedAt: null,
        customer: { branchId: user.branchId, deletedAt: null },
      },
      include: { customer: true },
    });
    if (!account) throw new NotFoundException('Müşteri veresiye hesabı bulunamadı.');

    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.debtTransaction.create({
        data: {
          id: newId(),
          debtAccountId: account.id,
          type: DebtTxnType.DebtAdd,
          amount: dto.amount,
          createdBy: user.userId,
          note: dto.note ?? 'Manuel borç ekleme',
          occurredAt: new Date(),
          deviceId: user.deviceId ?? null,
        },
      });

      await tx.debtAccount.update({
        where: { id: account.id },
        data: {
          balance: { increment: dto.amount },
          version: { increment: 1 },
        },
      });

      return txn;
    });
  }

  async payDebt(user: AuthUser, customerId: string, dto: PayDebtDto) {
    const account = await this.prisma.debtAccount.findFirst({
      where: {
        customerId,
        deletedAt: null,
        customer: { branchId: user.branchId, deletedAt: null },
      },
      include: { customer: true },
    });
    if (!account) throw new NotFoundException('Müşteri veresiye hesabı bulunamadı.');

    // Borctan fazla tahsilat: normalde engellenir; kullanici acikca onayladiginda
    // (allowOverpay) uyari ile devam edilebilir -> bakiye eksiye (alacak) doner.
    if (dto.amount > account.balance && !dto.allowOverpay) {
      throw new BadRequestException({
        code: 'BILL_OVERPAY',
        message: `Tahsilat tutari kalan borcu (${account.balance}) asamaz.`,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Borç ödemesini kaydet
      const txn = await tx.debtTransaction.create({
        data: {
          id: newId(),
          debtAccountId: account.id,
          type: DebtTxnType.Payment,
          amount: -dto.amount, // Ödeme borcu azaltır
          createdBy: user.userId,
          note: dto.note ?? 'Veresiye tahsilatı',
          occurredAt: new Date(),
          deviceId: user.deviceId ?? null,
        },
      });

      // 2. Cari bakiyeyi güncelle
      const updated = await tx.debtAccount.updateMany({
        where: { id: account.id, version: account.version },
        data: {
          balance: { decrement: dto.amount },
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Cari hesap es zamanli olarak degisti. Lutfen tekrar deneyin.');
      }

      // 3. Yalnizca NAKIT tahsilat kasa cekmecesine girer (kart/havale drawer'a girmez).
      const activeSession =
        dto.method === 'cash'
          ? await tx.cashSession.findFirst({
              where: { branchId: user.branchId, status: 'open', deletedAt: null },
            })
          : null;

      if (activeSession) {
        await tx.cashTransaction.create({
          data: {
            id: newId(),
            cashSessionId: activeSession.id,
            type: CashTxnType.Income,
            amount: dto.amount,
            method: dto.method,
            createdBy: user.userId,
            note: `${account.customer.name} veresiye tahsilatı`,
            deviceId: user.deviceId ?? null,
          },
        });
      }

      return txn;
    });
  }

  // ===========================================================================
  // Domain Event Listener
  // ===========================================================================
  @OnEvent('order.paid', DURABLE_LISTENER)
  async handleOrderPaid(
    event: DomainEvent<
      'order.paid',
      {
        amount: number;
        method: string;
        orderId: string;
        customerId?: string | null;
        paymentId: string;
      }
    >,
  ) {
    const { amount, method, orderId, customerId, paymentId } = event.payload;
    if (method !== 'debt') return;
    if (
      paymentId &&
      (await this.prisma.debtTransaction.findUnique({
        where: { relatedPaymentId: paymentId },
      }))
    ) {
      return;
    }

    if (!customerId) {
      this.logger.error(
        `Received order.paid event with method 'debt' but no customerId provided for order: ${orderId}`,
      );
      return;
    }

    const account = await this.prisma.debtAccount.findFirst({
      where: {
        customerId,
        deletedAt: null,
        customer: { branchId: event.branchId, deletedAt: null },
      },
    });

    if (!account) {
      this.logger.error(`DebtAccount not found for customer: ${customerId}`);
      return;
    }

    this.logger.log(
      `Received order.paid (debt) event. Accruing veresiye debt for customer: ${customerId}, order: ${orderId}`,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.debtTransaction.create({
        data: {
          id: newId(),
          debtAccountId: account.id,
          type: DebtTxnType.DebtAdd,
          amount,
          relatedOrderId: orderId,
          relatedPaymentId: paymentId ?? null,
          createdBy: event.actorId || 'system',
          note: `Adisyon borç kaydı (Ref No: ${orderId})`,
          occurredAt: new Date(),
          deviceId: event.deviceId ?? null,
        },
      });

      await tx.debtAccount.update({
        where: { id: account.id },
        data: {
          balance: { increment: amount },
          version: { increment: 1 },
        },
      });
    });
  }

  @OnEvent('order.refunded', DURABLE_LISTENER)
  async handleOrderRefunded(
    event: DomainEvent<
      'order.refunded',
      {
        amount: number;
        method: string;
        orderId: string;
        customerId?: string | null;
        paymentId: string;
      }
    >,
  ) {
    const { amount, method, orderId, customerId, paymentId } = event.payload;
    if (method !== 'debt') return;
    if (
      paymentId &&
      (await this.prisma.debtTransaction.findUnique({
        where: { relatedPaymentId: paymentId },
      }))
    ) {
      return;
    }

    if (!customerId) {
      this.logger.error(
        `Received order.refunded (debt) but no customerId provided for order: ${orderId}`,
      );
      return;
    }

    const account = await this.prisma.debtAccount.findFirst({
      where: {
        customerId,
        deletedAt: null,
        customer: { branchId: event.branchId, deletedAt: null },
      },
    });
    if (!account) {
      this.logger.error(`DebtAccount not found for customer: ${customerId}`);
      return;
    }

    this.logger.log(
      `Received order.refunded (debt). Reversing veresiye debt for customer: ${customerId}, order: ${orderId}`,
    );

    // Telafi kaydi (append-only): orijinal borc kaydini silmeyiz, azaltan kayit ekleriz.
    await this.prisma.$transaction(async (tx) => {
      await tx.debtTransaction.create({
        data: {
          id: newId(),
          debtAccountId: account.id,
          type: DebtTxnType.Payment,
          amount: -amount, // borcu azaltan kayit NEGATIF (payDebt ile ayni isaret; ekstre bakiyesi txn toplamindan yurur)
          relatedOrderId: orderId,
          relatedPaymentId: paymentId ?? null,
          createdBy: event.actorId || 'system',
          note: `Adisyon iadesi - borç geri alma (Ref No: ${orderId})`,
          occurredAt: new Date(),
          deviceId: event.deviceId ?? null,
        },
      });

      await tx.debtAccount.update({
        where: { id: account.id },
        data: {
          balance: { decrement: amount },
          version: { increment: 1 },
        },
      });
    });
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { businessDayWindow } from './reports.calc';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private parseRange(start: string, end: string): [Date, Date] {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (
      !Number.isFinite(startDate.getTime()) ||
      !Number.isFinite(endDate.getTime()) ||
      startDate > endDate ||
      endDate.getTime() - startDate.getTime() > 366 * 86_400_000
    ) {
      throw new BadRequestException({
        code: 'REPORT_RANGE_INVALID',
        message: 'Rapor tarih araligi gecersiz veya 366 gunden uzun.',
      });
    }
    return [startDate, endDate];
  }

  // Yonteme gore NET tahsilat = charge - refund. Iade kayitlari POZITIF tutar +
  // direction='refund' ile durur; direction'siz toplam iadeyi tahsilat gibi sisirir.
  private async paymentsNetByMethod(branchId: string, paidAt: Prisma.DateTimeFilter) {
    const grouped = await this.prisma.payment.groupBy({
      by: ['method', 'direction'],
      where: { order: { branchId }, paidAt, deletedAt: null },
      _sum: { amount: true },
    });
    const byMethod = new Map<string, number>();
    for (const g of grouped) {
      const sign = g.direction === 'refund' ? -1 : 1;
      byMethod.set(g.method, (byMethod.get(g.method) ?? 0) + sign * (g._sum.amount ?? 0));
    }
    return [...byMethod.entries()].map(([method, totalKurus]) => ({ method, totalKurus }));
  }

  // Gun sonu (Z) ozeti: tek is-gunu icin satis + odeme + kasa oturumu + gider/gelir.
  // Sahibin gunu kapatirken okudugu tek rapor. Veresiye ayri raporda (customers/debt).
  async getEndOfDay(user: AuthUser, date: string) {
    const { day, start, end } = businessDayWindow(date);

    // Ciro penceresi KAPANIS anina gore: tahsilat da paidAt ile filtreleniyor.
    // openedAt kullanilirsa dun acilip bugun odenen adisyonun parasi rapora
    // girer ama cirosu girmez -> rapor tutmaz. Tum rapor sorgulari closedAt.
    const ordersSummary = await this.prisma.order.aggregate({
      where: {
        branchId: user.branchId,
        completedAt: { gte: start, lt: end },
        deletedAt: null,
      },
      _count: { id: true },
      _sum: { subtotal: true, discountTotal: true, grandTotal: true },
    });

    const paymentsByMethod = await this.paymentsNetByMethod(user.branchId, {
      gte: start,
      lt: end,
    });

    // Satis tipine gore (salon / gel-al / paket) kirilim.
    const salesByType = await this.prisma.order.groupBy({
      by: ['type'],
      where: {
        branchId: user.branchId,
        completedAt: { gte: start, lt: end },
        deletedAt: null,
      },
      _count: { id: true },
      _sum: { grandTotal: true },
    });

    const sessions = await this.prisma.cashSession.findMany({
      where: { branchId: user.branchId, businessDay: day, deletedAt: null },
      orderBy: { openedAt: 'asc' },
    });

    const expenses = await this.prisma.expense.aggregate({
      where: { branchId: user.branchId, spentAt: { gte: start, lt: end }, deletedAt: null },
      _sum: { amount: true },
    });
    const incomes = await this.prisma.income.aggregate({
      where: { branchId: user.branchId, receivedAt: { gte: start, lt: end }, deletedAt: null },
      _sum: { amount: true },
    });

    return {
      businessDay: day,
      sales: {
        count: ordersSummary._count.id || 0,
        grossKurus: ordersSummary._sum.subtotal || 0,
        discountKurus: ordersSummary._sum.discountTotal || 0,
        netKurus: ordersSummary._sum.grandTotal || 0,
      },
      payments: paymentsByMethod,
      salesByType: salesByType.map((t) => ({
        type: t.type,
        count: t._count.id || 0,
        netKurus: t._sum.grandTotal || 0,
      })),
      cash: {
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          openedAt: s.openedAt,
          closedAt: s.closedAt,
          openingFloatKurus: s.openingFloat,
          expectedKurus: s.expectedAmount,
          countedKurus: s.countedAmount,
          differenceKurus: s.difference,
        })),
        differenceTotalKurus: sessions.reduce((sum, s) => sum + (s.difference ?? 0), 0),
      },
      expensesKurus: expenses._sum.amount || 0,
      incomesKurus: incomes._sum.amount || 0,
    };
  }

  // Ara rapor (X): ACIK kasa oturumunun anlik ozeti. Kasayi KAPATMAZ (Z'den fark
  // bu). Pencere = [oturum acilis, simdi]. Satis/odeme/gelir-gider + beklenen
  // nakit canli okunur. Acik oturum yoksa null.
  async getShiftReport(user: AuthUser) {
    const session = await this.prisma.cashSession.findFirst({
      where: { branchId: user.branchId, status: 'open', deletedAt: null },
    });
    if (!session) return null;

    const start = session.openedAt;
    const end = new Date();

    const ordersSummary = await this.prisma.order.aggregate({
      where: {
        branchId: user.branchId,
        completedAt: { gte: start, lt: end },
        deletedAt: null,
      },
      _count: { id: true },
      _sum: { subtotal: true, discountTotal: true, grandTotal: true },
    });

    const paymentsByMethod = await this.paymentsNetByMethod(user.branchId, {
      gte: start,
      lt: end,
    });

    const salesByType = await this.prisma.order.groupBy({
      by: ['type'],
      where: {
        branchId: user.branchId,
        completedAt: { gte: start, lt: end },
        deletedAt: null,
      },
      _count: { id: true },
      _sum: { grandTotal: true },
    });

    const expenses = await this.prisma.expense.aggregate({
      where: { branchId: user.branchId, spentAt: { gte: start, lt: end }, deletedAt: null },
      _sum: { amount: true },
    });
    const incomes = await this.prisma.income.aggregate({
      where: { branchId: user.branchId, receivedAt: { gte: start, lt: end }, deletedAt: null },
      _sum: { amount: true },
    });

    // Beklenen nakit = acilis + acilis/kapanis disi tum kasa hareketleri
    // (closeSession + KasaScreen ile ayni formul).
    const cashTxns = await this.prisma.cashTransaction.findMany({
      where: { cashSessionId: session.id, deletedAt: null },
      select: { type: true, amount: true },
    });
    const expectedCashKurus = cashTxns.reduce(
      (sum, t) => (t.type === 'opening' || t.type === 'closing' ? sum : sum + t.amount),
      session.openingFloat,
    );

    // Kasa ekraninin "son islemler" listesi: kasa cekmecesi yalnizca nakdi
    // tutar, kart/havale/QR/veresiye hic girmez. Yonteme bakmaksizin son 20
    // tahsilat/iade -> kullanici tum para girisini tek yerde gorur.
    const recent = await this.prisma.payment.findMany({
      where: {
        order: { branchId: user.branchId },
        paidAt: { gte: start, lt: end },
        deletedAt: null,
      },
      orderBy: { paidAt: 'desc' },
      take: 20,
      select: {
        id: true,
        orderId: true,
        method: true,
        direction: true,
        amount: true,
        paidAt: true,
        order: { select: { orderNo: true, isPaid: true } },
        reversedBy: { select: { id: true } },
      },
    });

    // Veresiye tahsilati ne Payment'tir ne de (karta/havaleye odendiyse) kasa
    // hareketi: para girer ama hicbir listede gorunmez. Toplam olarak gosterilir.
    // ponytail: yontem kirilimi yok -> DebtTransaction'da method kolonu yok;
    // gerekirse kolon + migration ile eklenir.
    const debtCollected = await this.prisma.debtTransaction.aggregate({
      where: {
        type: 'payment',
        occurredAt: { gte: start, lt: end },
        deletedAt: null,
        debtAccount: { customer: { branchId: user.branchId } },
      },
      _sum: { amount: true },
    });

    return {
      sessionId: session.id,
      openedAt: session.openedAt,
      debtCollectedKurus: -(debtCollected._sum.amount ?? 0),
      recentPayments: recent.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        method: p.method,
        direction: p.direction,
        amountKurus: p.amount,
        paidAt: p.paidAt,
        orderNo: p.order.orderNo,
        reversed: p.reversedBy.length > 0, // kasadaki "İade" dugmesi bir kez gorunur
        orderPaid: p.order.isPaid, // "Fiş" (yeniden yazdir) yalniz odenmis adisyonda
      })),
      generatedAt: end,
      openingFloatKurus: session.openingFloat,
      sales: {
        count: ordersSummary._count.id || 0,
        grossKurus: ordersSummary._sum.subtotal || 0,
        discountKurus: ordersSummary._sum.discountTotal || 0,
        netKurus: ordersSummary._sum.grandTotal || 0,
      },
      payments: paymentsByMethod,
      salesByType: salesByType.map((t) => ({
        type: t.type,
        count: t._count.id || 0,
        netKurus: t._sum.grandTotal || 0,
      })),
      expensesKurus: expenses._sum.amount || 0,
      incomesKurus: incomes._sum.amount || 0,
      expectedCashKurus,
    };
  }

  // Gun sonu gecmisi: kapanmis kasa oturumlarini (her biri bir gun-sonu kaydi)
  // saklanan Z rakamlariyla listeler. Recompute yok -> kapanista dondurulan
  // beklenen/sayilan/fark aynen okunur. Detay icin getEndOfDay(businessDay).
  async getEndOfDayHistory(user: AuthUser, limit = 90) {
    const sessions = await this.prisma.cashSession.findMany({
      where: { branchId: user.branchId, status: 'closed', deletedAt: null },
      orderBy: { closedAt: 'desc' },
      take: limit,
    });
    return sessions.map((s) => ({
      id: s.id,
      businessDay: s.businessDay,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      openingFloatKurus: s.openingFloat,
      expectedKurus: s.expectedAmount ?? 0,
      countedKurus: s.countedAmount ?? 0,
      differenceKurus: s.difference ?? 0,
    }));
  }

  async getDailySales(user: AuthUser, start: string, end: string) {
    const [startDate, endDate] = this.parseRange(start, end);

    // Completed orders count and sum
    const ordersSummary = await this.prisma.order.aggregate({
      where: {
        branchId: user.branchId,
        completedAt: { gte: startDate, lte: endDate },
        deletedAt: null,
      },
      _count: { id: true },
      _sum: { grandTotal: true, discountTotal: true },
    });

    // Payments by method (net: tahsilat - iade)
    const paymentsByMethod = await this.paymentsNetByMethod(user.branchId, {
      gte: startDate,
      lte: endDate,
    });

    // Satis tipine gore (salon / gel-al / paket) kirilim.
    const salesByType = await this.prisma.order.groupBy({
      by: ['type'],
      where: {
        branchId: user.branchId,
        completedAt: { gte: startDate, lte: endDate },
        deletedAt: null,
      },
      _count: { id: true },
      _sum: { grandTotal: true },
    });

    // Basilan fisler (hesap fisi 'bill' + odendi fisi 'customer') — geri donup bakmak icin.
    const receipts = await this.prisma.receipt.findMany({
      where: {
        order: { branchId: user.branchId },
        type: { in: ['bill', 'customer'] },
        printedAt: { gte: startDate, lte: endDate },
        deletedAt: null,
      },
      include: { order: { select: { orderNo: true, grandTotal: true } } },
      orderBy: { printedAt: 'desc' },
      take: 200,
    });

    // Sales by product categories
    const items = await this.prisma.orderItem.findMany({
      where: {
        order: {
          branchId: user.branchId,
          completedAt: { gte: startDate, lte: endDate },
          deletedAt: null,
        },
        deletedAt: null,
        status: { not: 'cancelled' }, // void edilmis kalem satisa sayilmaz
      },
      include: {
        product: { include: { category: true } },
      },
    });

    const categoryBreakdown: Record<string, number> = {};
    for (const item of items) {
      const catName = item.product?.category?.name || 'Kategorisiz';
      categoryBreakdown[catName] = (categoryBreakdown[catName] || 0) + item.lineTotal;
    }

    return {
      salesCount: ordersSummary._count.id || 0,
      salesTotalKurus: ordersSummary._sum.grandTotal || 0,
      discountTotalKurus: ordersSummary._sum.discountTotal || 0,
      payments: paymentsByMethod,
      salesByType: salesByType.map((t) => ({
        type: t.type,
        count: t._count.id || 0,
        netKurus: t._sum.grandTotal || 0,
      })),
      receipts: receipts.map((r) => ({
        receiptNo: r.receiptNo,
        type: r.type, // bill (Hesap) | customer (Ödendi)
        orderNo: r.order.orderNo,
        printedAt: r.printedAt!.toISOString(),
        totalKurus: r.order.grandTotal,
      })),
      categoryBreakdown: Object.entries(categoryBreakdown).map(([category, totalKurus]) => ({
        category,
        totalKurus,
      })),
    };
  }

  async getProductSales(user: AuthUser, start: string, end: string) {
    const [startDate, endDate] = this.parseRange(start, end);

    const items = await this.prisma.orderItem.findMany({
      where: {
        order: {
          branchId: user.branchId,
          completedAt: { gte: startDate, lte: endDate },
          deletedAt: null,
        },
        deletedAt: null,
        status: { not: 'cancelled' }, // void edilmis kalem satisa sayilmaz
      },
      include: {
        product: true,
      },
    });

    const productSales: Record<
      string,
      { name: string; quantityMilis: number; totalKurus: number }
    > = {};
    for (const item of items) {
      const prodId = item.productId;
      if (!productSales[prodId]) {
        productSales[prodId] = {
          name: item.productNameSnapshot || item.product.name,
          quantityMilis: 0,
          totalKurus: 0,
        };
      }
      productSales[prodId].quantityMilis += item.quantity;
      productSales[prodId].totalKurus += item.lineTotal;
    }

    return Object.values(productSales).sort((a, b) => b.totalKurus - a.totalKurus);
  }

  async getCustomerDebts(user: AuthUser) {
    const accounts = await this.prisma.debtAccount.findMany({
      where: {
        customer: { branchId: user.branchId, isActive: true, deletedAt: null },
      },
      include: {
        customer: true,
      },
    });

    return accounts
      .map((acc) => ({
        customerId: acc.customerId,
        customerName: acc.customer.name,
        phone: acc.customer.phone,
        balanceKurus: acc.balance,
      }))
      .sort((a, b) => b.balanceKurus - a.balanceKurus);
  }

  async getInventoryStocks(user: AuthUser) {
    const products = await this.prisma.product.findMany({
      where: {
        branchId: user.branchId,
        trackStock: true,
        deletedAt: null,
      },
      include: {
        unit: true,
        stockMovements: {
          where: { deletedAt: null },
        },
      },
    });

    return products.map((prod) => {
      const currentStockMilis = prod.stockMovements.reduce((sum, mov) => sum + mov.quantity, 0);
      return {
        productId: prod.id,
        name: prod.name,
        unit: prod.unit.name,
        minStockMilis: prod.minStock,
        currentStockMilis,
        costPriceKurus: prod.purchasePrice,
        stockValueKurus: Math.round((currentStockMilis * prod.purchasePrice) / 1000),
      };
    });
  }
}

import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrderStatus, PaymentDirection, TableStatus } from '@ado/shared';

/**
 * Adisyon islemlerinin ISLEM ICI ortak yardimcilari (orders + payments).
 * Hepsi `tx` alir: islem icinde `this.prisma` sorgusu kalmaz (SQLite tek baglanti
 * havuzunda islem disi sorgu islemin kendisini bekler ve kilitlenir).
 */
export type Tx = Prisma.TransactionClient;

/** Masayi dolu tutan adisyon durumlari (masa basina tek aktif adisyon indeksi ile ayni). */
export const ACTIVE_ORDER_STATUSES: string[] = [OrderStatus.Open, OrderStatus.Held];

/** Kosullu yazim tutmadi: adisyon okunduktan sonra baska bir islem onu degistirdi. */
export function orderChangedError(): ConflictException {
  return new ConflictException({
    code: 'ORDER_CHANGED',
    message: 'Adisyon başka bir işlemle aynı anda değişti; ekranı yenileyip tekrar deneyin.',
  });
}

/**
 * Iyimser kilit: adisyonu YALNIZ okundugu surumde ve beklenen durumdaysa gunceller
 * (`updateMany where {id, version, status}`); tutmazsa 409 ORDER_CHANGED. Boylece
 * odeme ile kalem ekleme yarisinda kapanmis adisyona yazilamaz.
 */
export async function writeOrderTx(
  tx: Tx,
  snapshot: { id: string; version: number },
  data: Prisma.OrderUncheckedUpdateManyInput,
  statuses: string[] = [OrderStatus.Open],
) {
  const res = await tx.order.updateMany({
    where: {
      id: snapshot.id,
      version: snapshot.version,
      status: { in: statuses },
      deletedAt: null,
    },
    data: { ...data, version: { increment: 1 }, syncState: 'pending' },
  });
  if (res.count !== 1) throw orderChangedError();
  return tx.order.findUniqueOrThrow({ where: { id: snapshot.id } });
}

/** Adisyona alinmis NET odeme (tahsilat - iade), islem icinde. */
export async function netPaidTx(tx: Tx, orderId: string): Promise<number> {
  const rows = await tx.payment.groupBy({
    by: ['direction'],
    where: { orderId, deletedAt: null },
    _sum: { amount: true },
  });
  return rows.reduce(
    (sum, row) =>
      sum + (row.direction === PaymentDirection.Refund ? -1 : 1) * (row._sum.amount ?? 0),
    0,
  );
}

/** Masada baska aktif (acik/bekleyen) adisyon kalmadiysa masayi bosaltir. */
export async function freeTableIfIdleTx(tx: Tx, branchId: string, tableId: string) {
  const stillActive = await tx.order.count({
    where: { branchId, tableId, status: { in: ACTIVE_ORDER_STATUSES }, deletedAt: null },
  });
  if (stillActive === 0) {
    await tx.table.update({
      where: { id: tableId },
      data: { status: TableStatus.Empty, version: { increment: 1 }, syncState: 'pending' },
    });
  }
}

/** Masadaki aktif adisyon (yoksa null). `exceptOrderId` kendisini saymamak icin. */
export function activeOrderOnTableTx(
  tx: Tx,
  branchId: string,
  tableId: string,
  exceptOrderId?: string,
) {
  return tx.order.findFirst({
    where: {
      branchId,
      tableId,
      status: { in: ACTIVE_ORDER_STATUSES },
      deletedAt: null,
      ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}),
    },
    select: { id: true, orderNo: true },
  });
}

/** Benzersiz indeks ihlali (Prisma P2002 ya da sema disi ham indeksten SQLite hatasi). */
export function isUniqueViolation(e: unknown): boolean {
  return (
    (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') ||
    /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : '')
  );
}

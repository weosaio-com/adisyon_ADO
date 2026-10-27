// Masasiz adisyonun etiketi (SAT-20): bolunerek ayrilan hesap "Gel-al" gorunmez; hangi masadan
// ayrildigi yazilir. Self-check: order-label.selfcheck.ts

export interface LabelOrder {
  id: string;
  tableId: string | null;
  type?: string;
  parentOrderId?: string | null;
}

/**
 * Masasiz adisyon etiketi: paket / gel-al ya da "Ayrı hesap · Masa 5" (bolunen adisyon; kaynak
 * adisyon acik listede ise masasinin adi, degilse yalniz "Ayrı hesap").
 */
export function looseOrderLabel(
  order: LabelOrder,
  openOrders: LabelOrder[],
  tableName: (id: string) => string | undefined,
): string {
  if (order.type === 'delivery') return 'Paket';
  if (order.type === 'takeaway') return 'Gel-al';
  if (order.parentOrderId) {
    const parent = openOrders.find((o) => o.id === order.parentOrderId);
    const name = parent?.tableId ? tableName(parent.tableId) : undefined;
    return name ? `Ayrı hesap · ${name}` : 'Ayrı hesap';
  }
  return 'Gel-al';
}

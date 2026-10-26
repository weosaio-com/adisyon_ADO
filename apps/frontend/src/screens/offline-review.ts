// Cevrimdisi onay kuyrugu: kayitlari siparis (grup) duzeyinde toplar. OFF-2
// Self-check: offline-review.selfcheck.ts

export interface ReviewContext {
  groupKey: string;
  waiterName: string | null;
  tableId: string | null;
  tableName: string | null;
  orderId: string | null;
  orderNo: string | null;
  orderStatus: string | null;
  canReopen: boolean;
  productName: string | null;
  quantity: number | null;
  seenPrice: number | null;
  currentPrice: number | null;
  productActive: boolean | null;
}

export interface ReviewRow {
  id: string;
  deviceId: string;
  waiterId: string;
  clientOpId: string;
  mutationType: string;
  mutationPayload: string;
  reason: string;
  createdAt: string;
  context?: ReviewContext;
}

export interface ReviewLine {
  id: string;
  name: string;
  quantity: number; // milis
  seenPrice: number | null;
  currentPrice: number | null;
}

/**
 * new: siparis hic acilmadi (OPEN_TABLE onayda) -> "Siparişi uygula" (masa secilebilir).
 * open: asil adisyon acik (or. fiyat farki) -> "Adisyona ekle".
 * closed: asil adisyon kapali / bulunamadi -> "Yeni adisyon aç" (+ uygunsa "Yeniden aç").
 */
export type GroupKind = 'new' | 'open' | 'closed';

export interface ReviewGroup {
  key: string;
  ids: string[];
  kind: GroupKind;
  reason: string;
  tableId: string | null;
  tableName: string | null;
  waiterName: string | null;
  deviceId: string;
  createdAt: string;
  orderNo: string | null;
  canReopen: boolean;
  submit: boolean;
  lines: ReviewLine[];
}

function payloadOf(row: ReviewRow): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.mutationPayload);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Ayni siparisin kayitlari (OPEN_TABLE + kalemler + mutfaga gonder) tek kart olur. */
export function groupReviews(rows: ReviewRow[]): ReviewGroup[] {
  const groups = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    const key = row.context?.groupKey ?? `review:${row.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) =>
      a.clientOpId < b.clientOpId ? -1 : a.clientOpId > b.clientOpId ? 1 : 0,
    );
    const open = sorted.find((r) => r.mutationType === 'OPEN_TABLE');
    const first = open ?? sorted[0]!;
    const withTable = sorted.find((r) => r.context?.tableId) ?? first;
    const kind: GroupKind = open
      ? 'new'
      : sorted.some((r) => r.context?.orderStatus === 'open')
        ? 'open'
        : 'closed';
    return {
      key,
      ids: sorted.map((r) => r.id),
      kind,
      reason: first.reason,
      tableId: withTable.context?.tableId ?? null,
      tableName: withTable.context?.tableName ?? null,
      waiterName: first.context?.waiterName ?? null,
      deviceId: first.deviceId,
      createdAt: first.createdAt,
      orderNo: sorted.find((r) => r.context?.orderNo)?.context?.orderNo ?? null,
      canReopen: sorted.some((r) => r.context?.canReopen),
      submit: sorted.some((r) => r.mutationType === 'SUBMIT_ORDER'),
      lines: sorted
        .filter((r) => r.mutationType === 'ADD_LINE')
        .map((r) => {
          const p = payloadOf(r);
          return {
            id: r.id,
            name: r.context?.productName ?? String(p.productName ?? 'Ürün'),
            quantity: Number(r.context?.quantity ?? p.quantity ?? 1000),
            seenPrice: r.context?.seenPrice ?? null,
            currentPrice: r.context?.currentPrice ?? null,
          };
        }),
    };
  });
}

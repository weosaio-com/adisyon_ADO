import assert from 'node:assert';

/**
 * Adisyon toplam motoru (SAF fonksiyonlar — DB'siz, test edilebilir).
 * KDV fiyata DAHIL: grandTotal = subtotal - discountTotal (+ service + cover).
 * taxTotal bilgi amacli (icerideki KDV). Para = integer kurus, oran = binde.
 */
export type TotalsInput = { lineTotal: number; lineDiscount: number; taxRatePermille: number };

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  serviceCharge: number;
  coverCharge: number;
  grandTotal: number;
}

// Kalem toplamlari. gross = lineTotal + lineDiscount (indirimden onceki).
export function computeItemTotals(items: TotalsInput[]): OrderTotals {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const it of items) {
    subtotal += it.lineTotal + it.lineDiscount;
    discountTotal += it.lineDiscount;
    // KDV fiyata dahil -> icerideki vergi: net * rate / (1000 + rate).
    taxTotal += Math.round((it.lineTotal * it.taxRatePermille) / (1000 + it.taxRatePermille));
  }
  const serviceCharge = 0;
  const coverCharge = 0;
  const grandTotal = subtotal - discountTotal + serviceCharge + coverCharge;
  return { subtotal, discountTotal, taxTotal, serviceCharge, coverCharge, grandTotal };
}

// Adisyon-seviyesi indirimleri (satir indirimine EK) katar. KDV fiyata dahil oldugundan
// indirim KDV'yi de dusurur: indirim kalemlere net tutarlariyla orantili dagitilir ve
// icerideki KDV indirimli tutardan satir bazinda yeniden hesaplanir (`items` verilirse).
export function applyOrderDiscounts(
  totals: OrderTotals,
  orderDiscountAmounts: number[],
  items?: TotalsInput[],
): OrderTotals {
  const extra = orderDiscountAmounts.reduce((s, a) => s + a, 0);
  const discountTotal = totals.discountTotal + extra;
  const grandTotal = totals.subtotal - discountTotal + totals.serviceCharge + totals.coverCharge;
  let taxTotal = totals.taxTotal;
  if (extra > 0 && items) {
    const net = totals.subtotal - totals.discountTotal; // satir indirimleri dusulmus toplam
    const factor = net > 0 ? Math.max(0, net - extra) / net : 0;
    taxTotal = items.reduce(
      (sum, it) =>
        sum +
        Math.round((it.lineTotal * factor * it.taxRatePermille) / (1000 + it.taxRatePermille)),
      0,
    );
  }
  return { ...totals, discountTotal, taxTotal, grandTotal };
}

// --- Self-check: `ts-node src/orders/orders.calc.ts` ---
if (require.main === module) {
  // KDV %10 dahil: lineTotal 11000 -> icerideki KDV = 11000*100/1100 = 1000.
  const t1 = computeItemTotals([{ lineTotal: 11000, lineDiscount: 0, taxRatePermille: 100 }]);
  assert.strictEqual(t1.subtotal, 11000, 'subtotal');
  assert.strictEqual(t1.taxTotal, 1000, 'KDV dahil tax');
  assert.strictEqual(t1.grandTotal, 11000, 'grandTotal');

  // Satir indirimi: gross 10000, indirim 1000 -> grandTotal 9000.
  const t2 = computeItemTotals([{ lineTotal: 9000, lineDiscount: 1000, taxRatePermille: 100 }]);
  assert.strictEqual(t2.subtotal, 10000, 'gross subtotal');
  assert.strictEqual(t2.discountTotal, 1000, 'satir indirim');
  assert.strictEqual(t2.grandTotal, 9000, 'indirimli grandTotal');

  // Adisyon-seviyesi indirim eklenince grandTotal duser.
  const t3 = applyOrderDiscounts(
    computeItemTotals([{ lineTotal: 10000, lineDiscount: 0, taxRatePermille: 0 }]),
    [3000],
  );
  assert.strictEqual(t3.discountTotal, 3000, 'adisyon indirim');
  assert.strictEqual(t3.grandTotal, 7000, 'adisyon indirimli grandTotal');

  // MERGE degismezligi: birlesik adisyon toplami = ayri toplamlarin toplami.
  const line = { lineTotal: 10000, lineDiscount: 0, taxRatePermille: 100 };
  const a = computeItemTotals([line]);
  const b = computeItemTotals([line]);
  const merged = computeItemTotals([line, line]);
  assert.strictEqual(merged.grandTotal, a.grandTotal + b.grandTotal, 'merge geliri korur');
  assert.strictEqual(merged.taxTotal, a.taxTotal + b.taxTotal, 'merge KDV korur');

  // SAT-3: adisyon indirimi icerideki KDV'yi de dusurur. 3 x 33,33 TL (%10) = 99,99 TL,
  // KDV 9,09 TL; %50 indirim (50,00 TL) sonrasi 49,99 TL -> KDV 4,54 TL.
  const kdvLine = [{ lineTotal: 9999, lineDiscount: 0, taxRatePermille: 100 }];
  const half = applyOrderDiscounts(computeItemTotals(kdvLine), [5000], kdvLine);
  assert.strictEqual(half.grandTotal, 4999, 'indirimli toplam');
  assert.strictEqual(half.taxTotal, 454, 'indirimli KDV');
  // Karisik oran: indirim satirlara orantili; tam indirimde KDV 0.
  const mixed = [
    { lineTotal: 11000, lineDiscount: 0, taxRatePermille: 100 },
    { lineTotal: 12000, lineDiscount: 0, taxRatePermille: 200 },
  ];
  const mixedHalf = applyOrderDiscounts(computeItemTotals(mixed), [11500], mixed);
  assert.strictEqual(mixedHalf.taxTotal, 500 + 1000, 'oranli dagitim (1000/2 + 2000/2)');
  assert.strictEqual(applyOrderDiscounts(computeItemTotals(mixed), [23000], mixed).taxTotal, 0);
  // Indirimsiz: KDV aynen.
  assert.strictEqual(applyOrderDiscounts(computeItemTotals(mixed), [], mixed).taxTotal, 3000);

  console.log('✓ orders.calc self-check OK');
}

// Onay kuyrugu gruplama self-check'i. Calistir: node --experimental-strip-types src/screens/offline-review.selfcheck.ts
import assert from 'node:assert/strict';
import { groupReviews, type ReviewRow } from './offline-review.ts';

const ctx = (groupKey: string, extra: Partial<NonNullable<ReviewRow['context']>> = {}) => ({
  groupKey,
  waiterName: 'Ali',
  tableId: null,
  tableName: null,
  orderId: null,
  orderNo: null,
  orderStatus: null,
  canReopen: false,
  productName: null,
  quantity: null,
  seenPrice: null,
  currentPrice: null,
  productActive: null,
  ...extra,
});
const row = (id: string, type: string, payload: object, context: ReviewRow['context']) => ({
  id,
  deviceId: 'dev1',
  waiterId: 'w1',
  clientOpId: id,
  mutationType: type,
  mutationPayload: JSON.stringify(payload),
  reason: 'cash_closed',
  createdAt: '2026-10-20T10:00:00Z',
  context,
});

// Tek siparis (masa ac + 2 kalem + mutfaga gonder) tek kart: eskiden 4 ayri kart, her birinde
// uc dugme ve masasiz / parcali adisyon.
const groups = groupReviews([
  row(
    'op3',
    'ADD_LINE',
    { productId: 'p2', quantity: 2000 },
    ctx('op:op1', { productName: 'Ayran' }),
  ),
  row('op1', 'OPEN_TABLE', { tableId: 't1' }, ctx('op:op1', { tableId: 't1', tableName: 'M5' })),
  row(
    'op2',
    'ADD_LINE',
    { productId: 'p1', quantity: 1000 },
    ctx('op:op1', { productName: 'Çay' }),
  ),
  row('op4', 'SUBMIT_ORDER', {}, ctx('op:op1')),
  row(
    'op9',
    'ADD_LINE',
    { productId: 'p1', quantity: 1000, unitPrice: 1500 },
    ctx('order:o7', {
      orderStatus: 'open',
      seenPrice: 1500,
      currentPrice: 2500,
      productName: 'Çay',
    }),
  ),
]);
assert.equal(groups.length, 2);
const order = groups.find((g) => g.key === 'op:op1')!;
assert.equal(order.kind, 'new');
assert.equal(order.tableName, 'M5');
assert.equal(order.submit, true);
assert.deepEqual(order.ids, ['op1', 'op2', 'op3', 'op4'], 'tabletin gonderim sirasi');
assert.deepEqual(
  order.lines.map((l) => [l.name, l.quantity]),
  [
    ['Çay', 1000],
    ['Ayran', 2000],
  ],
);
const price = groups.find((g) => g.key === 'order:o7')!;
assert.equal(price.kind, 'open');
assert.equal(price.lines[0]!.currentPrice, 2500);

// Asil adisyon kapali / bulunamadi: yeni adisyon karari.
const closed = groupReviews([
  row('x1', 'ADD_LINE', { orderId: 'o8' }, ctx('order:o8', { orderStatus: 'cancelled' })),
]);
assert.equal(closed[0]!.kind, 'closed');

console.log('offline-review self-check OK');

// Masasiz adisyon etiketi self-check'i. Calistir: node --experimental-strip-types src/screens/order-label.selfcheck.ts
import assert from 'node:assert/strict';
import { looseOrderLabel } from './order-label.ts';

const open = [{ id: 'o1', tableId: 't5', type: 'dine_in' }];
const name = (id: string) => (id === 't5' ? 'Masa 5' : undefined);
assert.equal(looseOrderLabel({ id: 'p', tableId: null, type: 'delivery' }, open, name), 'Paket');
assert.equal(looseOrderLabel({ id: 'g', tableId: null, type: 'takeaway' }, open, name), 'Gel-al');
// Bolunen hesap "Gel-al" degil: kaynak masasiyla.
assert.equal(
  looseOrderLabel({ id: 's', tableId: null, type: 'dine_in', parentOrderId: 'o1' }, open, name),
  'Ayrı hesap · Masa 5',
);
assert.equal(
  looseOrderLabel({ id: 's', tableId: null, type: 'dine_in', parentOrderId: 'kapali' }, open, name),
  'Ayrı hesap',
);
console.log('order-label self-check OK');

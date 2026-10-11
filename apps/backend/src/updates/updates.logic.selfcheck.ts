// Guncelleme kurallarinin self-check'i: `ts-node src/updates/updates.logic.selfcheck.ts`
import assert from 'node:assert';
import { approvalOutcome, updateBlockers } from './updates.logic';

assert.deepStrictEqual(updateBlockers({ local: true, openOrders: 0, cashOpen: false }), []);
assert.deepStrictEqual(
  updateBlockers({ local: false, openOrders: 2, cashOpen: true }).map((b) => b.code),
  ['NOT_LOCAL', 'OPEN_ORDERS', 'CASH_OPEN'],
);
assert.match(
  updateBlockers({ local: true, openOrders: 3, cashOpen: false })[0]!.message,
  /^3 açık/,
);

assert.strictEqual(approvalOutcome('0.3.1', '0.3.1'), 'applied');
assert.strictEqual(approvalOutcome('0.3.1', '0.3.0'), 'failed');

console.log('updates.logic.selfcheck OK');

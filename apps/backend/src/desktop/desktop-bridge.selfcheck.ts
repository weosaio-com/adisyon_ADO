// Masaustu IPC koprusunun self-check'i: `ts-node src/desktop/desktop-bridge.selfcheck.ts`
import assert from 'node:assert';
import {
  desktopMessageSchema,
  DesktopBridgeService,
  type DesktopMessage,
} from './desktop-bridge.service';

assert.ok(desktopMessageSchema.safeParse({ type: 'shutdown' }).success);
assert.ok(!desktopMessageSchema.safeParse({ type: 'format-c' }).success);
assert.ok(!desktopMessageSchema.safeParse('shutdown').success);

// Bu surec IPC ile baslatilmadi: kopru sessiz, mesaj dinlemez.
const bridge = new DesktopBridgeService();
assert.strictEqual(bridge.attached, false);

const seen: DesktopMessage[] = [];
const off = bridge.onMessage((message) => seen.push(message));
bridge.receive({ type: 'shutdown' });
bridge.receive({ type: 'bilinmeyen' });
bridge.receive(null);
assert.deepStrictEqual(seen, [{ type: 'shutdown' }]);
off();
bridge.receive({ type: 'shutdown' });
assert.strictEqual(seen.length, 1, 'aboneligi biten dinleyici cagrilmaz');

console.log('desktop-bridge.selfcheck OK');

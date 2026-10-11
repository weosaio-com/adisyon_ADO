// Masaustu IPC koprusunun self-check'i: `ts-node src/desktop/desktop-bridge.selfcheck.ts`
import assert from 'node:assert';
import {
  desktopMessageSchema,
  DesktopBridgeService,
  type DesktopMessage,
} from './desktop-bridge.service';

assert.ok(desktopMessageSchema.safeParse({ type: 'shutdown' }).success);
const ready = {
  type: 'update-status',
  state: 'ready',
  channel: 'stable',
  currentVersion: '0.3.0',
  version: '0.3.1',
  notes: 'Duzeltmeler',
  progress: 100,
  checkedAt: '2026-10-11T12:00:00.000Z',
};
assert.ok(desktopMessageSchema.safeParse(ready).success);
assert.ok(!desktopMessageSchema.safeParse({ ...ready, state: 'hacked' }).success);
assert.ok(!desktopMessageSchema.safeParse({ ...ready, channel: 'nightly' }).success);
assert.ok(!desktopMessageSchema.safeParse({ type: 'format-c' }).success);
assert.ok(!desktopMessageSchema.safeParse('shutdown').success);

// Bu surec IPC ile baslatilmadi: kopru sessiz, mesaj dinlemez.
const bridge = new DesktopBridgeService();
assert.strictEqual(bridge.attached, false);
assert.strictEqual(bridge.send({ type: 'update-check' }), false, 'kabuk yokken komut gitmez');

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

// Saf sync-core mantiginin runnable self-check'i (CONVENTIONS.md §7 kritik modul kapisi).
// Calistir: node --experimental-strip-types src/offline/sync-core.selfcheck.ts
import assert from 'node:assert';
import {
  CHUNK_MAX_BYTES,
  CHUNK_MAX_COUNT,
  applyResults,
  buildAddLine,
  buildOpenTable,
  buildSubmit,
  chunkEntries,
  classifyFailure,
  compareOutbox,
  describeEntry,
  problemMessage,
  wireSize,
  type OutboxEntry,
} from './sync-core.ts';
import { badgeView } from './sync-view.ts';

const { draft } = buildOpenTable({ orderId: 'local:1', clientOpId: 'op1' }, 't1', 'A1');
const add = buildAddLine(draft, 'op2', { id: 'p1', name: 'Cay', salePrice: 1500 });
assert.equal(add.draft.grandTotal, 1500);
assert.equal(add.entry.payload.orderClientOpId, 'op1');

const two = buildAddLine(add.draft, 'op3', { id: 'p1', name: 'Cay', salePrice: 1500 }, 2000);
assert.equal(two.draft.grandTotal, 1500 + 3000);

const sub = buildSubmit(two.draft, 'op4');
assert.ok(sub.draft.items.every((i) => i.status === 'sent'));

const oc = applyResults([
  { clientOpId: 'op1', status: 'applied', serverId: 'S1' },
  { clientOpId: 'op2', status: 'duplicate', serverId: 'I2' },
  { clientOpId: 'op3', status: 'conflict', reviewId: 'R1', reason: 'TABLE_CLOSED' },
  { clientOpId: 'op4', status: 'rejected', reason: 'PRODUCT_INACTIVE' },
]);
assert.deepEqual([...oc.remove].sort(), ['op1', 'op2', 'op3', 'op4']);
assert.equal(oc.serverIdByOpId.op1, 'S1');
assert.equal(oc.conflicts.length, 1);
assert.equal(oc.rejections.length, 1);

// --- OFF-1: dilimleme. 250 kayit -> 100+100+50, sira korunur (OPEN_TABLE ilk dilimin basinda).
const entry = (i: number, extra: Record<string, unknown> = {}): OutboxEntry => ({
  clientOpId: `op${String(i).padStart(4, '0')}`,
  type: i === 0 ? 'OPEN_TABLE' : 'ADD_LINE',
  payload: { orderClientOpId: 'op0000', productId: 'p1', quantity: 1000, ...extra },
  localOrderId: 'local:op0000',
  status: 'pending',
  retryCount: 0,
  createdAt: 0,
  seq: i + 1,
});
const queue = Array.from({ length: 250 }, (_, i) => entry(i));
const chunks = chunkEntries(queue);
assert.deepEqual(
  chunks.map((c) => c.length),
  [CHUNK_MAX_COUNT, CHUNK_MAX_COUNT, 50],
);
assert.equal(chunks[0]![0]!.type, 'OPEN_TABLE');
assert.deepEqual(chunks.flat(), queue, 'dilimler sirayi bozmaz');
// Bayt siniri: buyuk kayitlar daha kucuk dilimlere; siniri tek basina asan kayit tek basina.
const big = Array.from({ length: 10 }, (_, i) => entry(i + 1, { note: 'x'.repeat(20_000) }));
const bigChunks = chunkEntries(big);
assert.ok(bigChunks.length >= 4);
for (const c of bigChunks) {
  const bytes = c.reduce((sum, e) => sum + wireSize(e) + 1, 0);
  assert.ok(c.length === 1 || bytes <= CHUNK_MAX_BYTES, 'dilim ~64 KB');
}
const huge = entry(1, { note: 'y'.repeat(CHUNK_MAX_BYTES + 10) });
assert.deepEqual(
  chunkEntries([entry(0), huge, entry(2)]).map((c) => c.length),
  [1, 1, 1],
);

// --- OFF-1: hata siniflandirma. "Çevrimdışı" yalniz baglanti hatasinda.
assert.equal(classifyFailure(0, 'NETWORK_ERROR'), 'offline');
assert.equal(classifyFailure(0, 'TIMEOUT'), 'offline');
assert.equal(classifyFailure(422, 'VALIDATION_ERROR'), 'split');
assert.equal(classifyFailure(400, 'BAD_REQUEST'), 'split');
assert.equal(classifyFailure(413, 'PAYLOAD_TOO_LARGE'), 'split');
assert.equal(classifyFailure(500, 'PAYLOAD_TOO_LARGE'), 'split');
assert.equal(classifyFailure(503, 'DB_BUSY'), 'retry');
assert.equal(classifyFailure(500, 'INTERNAL_ERROR'), 'retry');
assert.equal(classifyFailure(409, 'DATA_CONFLICT'), 'retry');
assert.equal(classifyFailure(429, 'RATE_LIMITED'), 'retry');
assert.equal(classifyFailure(401, 'SESSION_EXPIRED'), 'blocked');
assert.equal(classifyFailure(403, 'FORBIDDEN'), 'blocked');

// --- OFF-17: gonderim sirasi seq'e gore; seq'siz eski kayitlar once (ULID sirasiyla).
const legacyA = { ...entry(5), seq: undefined, clientOpId: 'zz-legacy' };
const legacyB = { ...entry(6), seq: undefined, clientOpId: 'aa-legacy' };
const sorted = [entry(3), legacyA, { ...entry(1), clientOpId: 'zzz' }, legacyB].sort(compareOutbox);
assert.deepEqual(
  sorted.map((e) => e.clientOpId),
  ['aa-legacy', 'zz-legacy', 'zzz', 'op0003'],
  'saati geri alinmis tablette bile ekleme sirasi korunur',
);

// --- OFF-3: garsona anlasilir aciklama.
assert.equal(describeEntry(two.entry, two.draft), '2 × Cay');
assert.equal(
  problemMessage('rejected', 'PRODUCT_INACTIVE', '2 × Cay'),
  '2 × Cay: ürün satışa kapalı olduğu için eklenemedi.',
);
assert.match(problemMessage('conflict', 'cash_closed', 'Masa açma'), /yönetici onayı bekliyor/);
assert.match(problemMessage('failed', 'VALIDATION_ERROR', 'Not'), /kabul etmedi/);

// Rozet: sorun varsa "Sorun var"; baglanti hatasi her seyin onunde.
assert.equal(badgeView({ mode: 'online', problems: 0 }).mode, 'online');
assert.equal(badgeView({ mode: 'online', problems: 2 }).text, 'Sorun var');
assert.equal(badgeView({ mode: 'offline', problems: 2 }).text, 'Çevrimdışı');
assert.equal(badgeView({ mode: 'waiting', problems: 0 }).text, 'Gönderim bekliyor');

console.log('sync-core self-check OK');

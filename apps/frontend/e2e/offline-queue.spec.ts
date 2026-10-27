import { test, expect } from '@playwright/test';
import { monotonicFactory } from 'ulid';
import {
  call,
  ensureCashOpen,
  idbCount,
  makeFixtures,
  makeWaiter,
  ownerLogin,
  sessionContext,
  waitOfflineReady,
} from './api-helpers';

// OFF-1 / GUV-2: uzun kesintide biriken 200+ islem ve tek bozuk kayit kuyrugu kilitlemez.
// Kuyruk dilimler halinde (en cok 100 kayit / ~64 KB) sirayla gider; sunucunun reddettigi kayit
// ayrilip garsona gosterilir, kalanlar gonderilir. "Çevrimdışı" yalniz baglanti yokken.
const ulid = monotonicFactory();

interface OrderView {
  id: string;
  items: { status: string }[];
}

test('250 kayıtlık kuyruk ve bozuk kayıt: dilimlenip gönderilir, kuyruk takılmaz', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const owner = (await ownerLogin()).accessToken;
  await ensureCashOpen(owner);
  const fx = await makeFixtures(owner, { products: [1500], tables: 1 });
  const table = fx.tables[0]!;
  const product = fx.products[0]!;
  const waiter = await makeWaiter(owner);
  const context = await sessionContext(browser, waiter.login);
  const page = await context.newPage();
  const sizes: { count: number; bytes: number }[] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/sync/mutations')) return;
    const body = request.postData() ?? '';
    sizes.push({
      count: (JSON.parse(body) as { mutations: unknown[] }).mutations.length,
      bytes: Buffer.byteLength(body),
    });
  });

  await page.goto('/');
  await waitOfflineReady(page);
  await context.setOffline(true);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'offline');

  // Cevrimdisi alinmis uzun siparis: masa ac + 249 kalem + (arada) bozuk kayit + mutfaga gonder.
  const openOp = ulid();
  const ops: { clientOpId: string; type: string; payload: Record<string, unknown> }[] = [
    { clientOpId: openOp, type: 'OPEN_TABLE', payload: { tableId: table.id } },
  ];
  for (let i = 0; i < 249; i++) {
    ops.push({
      clientOpId: ulid(),
      type: 'ADD_LINE',
      payload: { orderClientOpId: openOp, productId: product.id, quantity: 1000 },
    });
    if (i === 120) ops.push({ clientOpId: ulid(), type: 'BOGUS', payload: {} });
  }
  ops.push({ clientOpId: ulid(), type: 'SUBMIT_ORDER', payload: { orderClientOpId: openOp } });
  await page.evaluate(
    ({ ops, localOrderId, tableId }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('ado-offline');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction(['outbox', 'drafts'], 'readwrite');
          ops.forEach((op, i) =>
            tx.objectStore('outbox').put({
              ...op,
              localOrderId,
              status: 'pending',
              retryCount: 0,
              createdAt: Date.now(),
              seq: i + 1,
            }),
          );
          tx.objectStore('drafts').put({
            id: localOrderId,
            clientOpId: ops[0]!.clientOpId,
            orderNo: '⏳ Uzun masa',
            tableId,
            status: 'open',
            items: [],
            subtotal: 0,
            discountTotal: 0,
            grandTotal: 0,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { ops, localOrderId: `local:${openOp}`, tableId: table.id },
  );
  expect(await idbCount(page, 'outbox')).toBe(ops.length);

  await context.setOffline(false);
  await expect.poll(() => idbCount(page, 'outbox'), { timeout: 90_000 }).toBe(0);

  // Her istek en cok 100 kayit ve ~64 KB (sunucu 200 kayit / 100 KB ustunu reddeder).
  expect(sizes.length).toBeGreaterThanOrEqual(3);
  for (const size of sizes) {
    expect(size.count).toBeLessThanOrEqual(100);
    expect(size.bytes).toBeLessThan(70 * 1024);
  }
  // Siparis eksiksiz ve mutfaga gitmis; bozuk kayit ayrildi ve garsona gosteriliyor.
  const orders = await call<OrderView[]>(
    'GET',
    `/orders?tableId=${table.id}&open=true`,
    undefined,
    owner,
  );
  expect(orders).toHaveLength(1);
  expect(orders[0]!.items).toHaveLength(249);
  expect(orders[0]!.items.every((item) => item.status === 'sent')).toBe(true);
  expect(await idbCount(page, 'problems')).toBe(1);
  const badge = page.getByTestId('sync-badge');
  await expect(badge).toHaveAttribute('data-mode', 'degraded');
  await badge.click();
  const panel = page.getByTestId('sync-panel');
  await expect(panel.getByTestId('sync-problem')).toHaveCount(1);
  await expect(panel.getByTestId('sync-problem')).toContainText('kabul etmedi');
  await panel.getByRole('button', { name: 'Anladım' }).click();
  await expect(panel.getByTestId('sync-problem')).toHaveCount(0);
  await expect(badge).toHaveAttribute('data-mode', 'online');
  await context.close();
});

import { test, expect } from '@playwright/test';
import {
  call,
  ensureCashOpen,
  makeFixtures,
  makeWaiter,
  ownerLogin,
  sessionContext,
  waitOfflineReady,
} from './api-helpers';

// OFF-4: Wi-Fi kopunca zaten acik masanin adisyonu gorunur (son snapshot) ve ona ekleme
// yapilabilir: ADD_LINE {orderId} + SUBMIT_ORDER {orderId} kuyruga yazilir, baglanti gelince
// sunucu adisyonuna eklenir ve yalniz bu kalemler mutfaga gider.
interface OrderView {
  id: string;
  items: { productId: string; status: string }[];
}

test('çevrimdışıyken açık adisyon görünür; eklenen ürün bağlantı gelince adisyona geçer', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const owner = (await ownerLogin()).accessToken;
  await ensureCashOpen(owner);
  const fx = await makeFixtures(owner, { products: [1500, 2000], tables: 1 });
  const [first, extra] = fx.products as [{ id: string }, { id: string }];
  const table = fx.tables[0]!;
  const order = await call<OrderView>('POST', '/orders', { tableId: table.id }, owner);
  await call('POST', `/orders/${order.id}/items`, { productId: first.id, quantity: 1000 }, owner);

  const waiter = await makeWaiter(owner);
  const context = await sessionContext(browser, waiter.login);
  const page = await context.newPage();
  await page.goto('/');
  await waitOfflineReady(page);

  await context.setOffline(true);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'offline');
  await page.getByTestId(`table-${table.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${order.id}$`));
  // Adisyon son bilinen haliyle gorunur (eskiden bos adisyon gorunuyordu).
  await expect(page.getByTestId('order-item')).toHaveCount(1);
  await expect(page.getByTestId('order-from-snapshot')).toBeVisible();

  // Ekleme engellenmez: kuyruga yazilir ve "bekliyor" olarak gosterilir.
  await page.getByTestId(`category-${fx.categoryId}`).click();
  await page.getByTestId(`product-${extra.id}`).click();
  await expect(page.getByTestId('order-item')).toHaveCount(2);
  await expect(page.getByTestId('item-offline')).toHaveCount(1);
  await page.getByTestId('send-kitchen').click();
  await expect(page.getByTestId('item-offline')).toContainText('mutfağa gidecek');

  await context.setOffline(false);
  await expect
    .poll(
      async () =>
        (await call<OrderView>('GET', `/orders/${order.id}`, undefined, owner)).items.length,
      { timeout: 30_000 },
    )
    .toBe(2);
  const server = await call<OrderView>('GET', `/orders/${order.id}`, undefined, owner);
  const status = (productId: string) => server.items.find((i) => i.productId === productId)?.status;
  // Yalniz bu tabletin ekledigi kalem mutfaga gitti; digerini garson ayrica gonderir.
  expect(status(extra.id)).toBe('sent');
  expect(status(first.id)).toBe('pending');
  await expect(page.getByTestId('order-item')).toHaveCount(2);
  await expect(page.getByTestId('item-offline')).toHaveCount(0, { timeout: 15_000 });
  await context.close();
});

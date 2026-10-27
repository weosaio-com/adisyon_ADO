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

// OFF-3: cevrimdisi alinan kalem senkronda reddedilirse ya da fiyati degismisse garsona
// soylenmeden silinmez / baska fiyatla yazilmaz: adisyonda ve masa planinda isaretlenir.
interface OrderView {
  id: string;
  items: { productId: string; unitPrice: number }[];
}

test('reddedilen ve fiyatı değişen çevrimdışı kalem garsona gösterilir', async ({ browser }) => {
  test.setTimeout(90_000);
  const owner = (await ownerLogin()).accessToken;
  await ensureCashOpen(owner);
  const fx = await makeFixtures(owner, { products: [1500, 2000], tables: 1 });
  const [cay, tost] = fx.products as [{ id: string }, { id: string }];
  const table = fx.tables[0]!;
  const waiter = await makeWaiter(owner);
  const context = await sessionContext(browser, waiter.login);
  const page = await context.newPage();
  await page.goto('/');
  await waitOfflineReady(page);

  await context.setOffline(true);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'offline');
  await page.getByTestId(`table-${table.id}`).click();
  await expect(page).toHaveURL(/\/orders\/local:/);
  await page.getByTestId(`category-${fx.categoryId}`).click();
  await page.getByTestId(`product-${cay.id}`).click();
  await page.getByTestId(`product-${tost.id}`).click();
  await expect(page.getByTestId('order-item')).toHaveCount(2);
  await page.getByTestId('send-kitchen').click();

  // Bu arada kasada: tost satisa kapatilir, caya zam yapilir.
  await call('PATCH', `/products/${tost.id}`, { isActive: false }, owner);
  await call('PATCH', `/products/${cay.id}`, { salePrice: 2500 }, owner);

  await context.setOffline(false);
  await expect(page).toHaveURL(/\/orders\/(?!local:)[^/]+$/, { timeout: 30_000 });
  const problems = page.getByTestId('order-problem');
  await expect(problems).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('order-problems')).toContainText('satışa kapalı');
  await expect(page.getByTestId('order-problems')).toContainText('fiyatı değişmiş');
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'degraded');

  // Sunucuda kalem baska fiyatla yazilmadi; fiyat farki yonetici onayinda.
  const serverId = page.url().split('/orders/')[1]!;
  const order = await call<OrderView>('GET', `/orders/${serverId}`, undefined, owner);
  expect(order.items).toHaveLength(0);
  const reviews = await call<{ clientOpId: string; reason: string }[]>(
    'GET',
    '/offline-reviews',
    undefined,
    owner,
  );
  expect(reviews.filter((r) => r.reason === 'price_changed').length).toBeGreaterThanOrEqual(1);

  // Masa planinda masa isaretli.
  await page.goto('/');
  await expect(page.getByTestId(`table-problem-${table.id}`)).toBeVisible();
  await context.close();
});

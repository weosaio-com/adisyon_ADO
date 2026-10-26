import { test, expect, type Page } from '@playwright/test';
import {
  API,
  call,
  ensureCashOpen,
  makeFixtures,
  makeWaiter,
  ownerLogin,
  sessionContext,
  waitOfflineReady,
} from './api-helpers';

// OFF-5: ortak tablette garson A cevrimdisi siparis alip cikis yapar, garson B girer: siparis
// B'nin degil A'nin adina yazilir. Bekleyen islem varken cikis onay ister; cikis sunucudaki
// oturumu da kapatir (yenileme belirteci gecersiz olur).
interface OrderView {
  id: string;
  openedBy: string;
  items: { addedBy: string }[];
}

async function pinLogin(page: Page, username: string, pin: string) {
  await page.getByRole('button', { name: 'Garson' }).click();
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[type="password"]').fill(pin);
  await page.getByRole('button', { name: 'Sisteme giriş yap' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test('çıkış yapan garsonun çevrimdışı siparişi onun adına yazılır; çıkış oturumu kapatır', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = (await ownerLogin()).accessToken;
  await ensureCashOpen(owner);
  const fx = await makeFixtures(owner, { products: [1500], tables: 1 });
  const table = fx.tables[0]!;
  const a = await makeWaiter(owner, 'Garson A');
  const b = await makeWaiter(owner, 'Garson B');
  const context = await sessionContext(browser, a.login);
  const page = await context.newPage();
  await page.goto('/');
  await waitOfflineReady(page);

  await context.setOffline(true);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'offline');
  await page.getByTestId(`table-${table.id}`).click();
  await expect(page).toHaveURL(/\/orders\/local:/);
  await page.getByTestId(`category-${fx.categoryId}`).click();
  await page.getByTestId(`product-${fx.products[0]!.id}`).click();
  await page.getByTestId('send-kitchen').click();
  await page.getByRole('button', { name: 'Masa planına dön' }).click();

  // Bekleyen islem varken cikis onay ister.
  await page.getByRole('button', { name: 'Çıkış' }).first().click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('gönderilmemiş 3 işlem');
  await dialog.getByTestId('confirm-dialog-confirm').click();
  await expect(page).toHaveURL(/\/login/);

  // Baglanti gelir, garson B girer: A'nin kayitlari A adina gider.
  await context.setOffline(false);
  await pinLogin(page, b.username, b.pin);
  await expect
    .poll(
      async () =>
        (await call<OrderView[]>('GET', `/orders?tableId=${table.id}&open=true`, undefined, owner))
          .length,
      { timeout: 30_000 },
    )
    .toBe(1);
  const [order] = await call<OrderView[]>(
    'GET',
    `/orders?tableId=${table.id}&open=true`,
    undefined,
    owner,
  );
  expect(order!.openedBy).toBe(a.id);
  expect(order!.items.map((i) => i.addedBy)).toEqual([a.id]);

  // B cikis yapar (bekleyen yok: onay sorulmaz); sunucudaki oturumu da kapanir.
  const refresh = await page.evaluate(() => localStorage.getItem('ado.refresh'));
  await page.getByRole('button', { name: 'Çıkış' }).first().click();
  await expect(page).toHaveURL(/\/login/);
  const renewed = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  expect(renewed.status).toBe(401);
  await context.close();
});

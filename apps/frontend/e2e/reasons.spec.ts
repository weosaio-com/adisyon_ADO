import { test, expect } from '@playwright/test';
import { call, ensureCashOpen, makeFixtures, ownerLogin, type Named } from './api-helpers';

// URN-3 / SAT-17: mutfaga gitmis kalem tek dokunusla iptal olmaz; iptal ve indirim gerekce ister.
interface OrderView {
  id: string;
  status: string;
  grandTotal: number;
  items: { id: string; status: string; voidReason?: string | null }[];
  discounts?: { reason?: string | null; amount: number }[];
}

let token = '';
let fx: { categoryId: string; products: Named[]; tables: Named[] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  token = (await ownerLogin()).accessToken;
  await ensureCashOpen(token);
  fx = await makeFixtures(token, { products: [3000], tables: 2 });
});

async function sentOrder(tableId: string): Promise<OrderView> {
  const order = await call<OrderView>('POST', '/orders', { tableId }, token);
  await call(
    'POST',
    `/orders/${order.id}/items`,
    { productId: fx.products[0]!.id, quantity: 1000 },
    token,
  );
  await call('POST', `/orders/${order.id}/send-kitchen`, {}, token);
  return call<OrderView>('GET', `/orders/${order.id}`, undefined, token);
}

test('mutfağa gitmiş kalem onay ve gerekçe olmadan iptal olmaz', async ({ page }) => {
  const order = await sentOrder(fx.tables[0]!.id);
  await page.goto(`/orders/${order.id}`);
  const item = page.getByTestId('order-item').first();
  await expect(item).toContainText('Mutfağa gönderildi');

  await item.getByRole('button', { name: 'İptal', exact: true }).click();
  const dialog = page.getByTestId('reason-dialog');
  await expect(dialog).toBeVisible();
  // Gerekce secilmeden onay calismaz; vazgecince kalem yerinde kalir.
  await expect(dialog.getByTestId('reason-confirm')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let server = await call<OrderView>('GET', `/orders/${order.id}`, undefined, token);
  expect(server.items[0]!.status).toBe('sent');

  await item.getByRole('button', { name: 'İptal', exact: true }).click();
  await dialog.getByRole('button', { name: 'Zayi' }).click();
  await dialog.getByTestId('reason-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(item).toContainText('İptal edildi');
  server = await call<OrderView>('GET', `/orders/${order.id}`, undefined, token);
  expect(server.items[0]!.status).toBe('cancelled');
  expect(server.items[0]!.voidReason).toBe('Zayi');
});

test('indirim gerekçeyle uygulanır', async ({ page }) => {
  const order = await sentOrder(fx.tables[1]!.id);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'İndirim', exact: true }).click();
  const modal = page.getByTestId('discount-modal');
  await modal.getByTestId('discount-value').fill('10');
  // Gerekce secilmeden uygulanmaz (sunucu da 400 REASON_REQUIRED doner).
  await expect(modal.getByTestId('discount-apply')).toBeDisabled();
  await modal.getByRole('button', { name: 'Diğer' }).click();
  await modal.getByTestId('reason-other').fill('Doğum günü');
  await modal.getByTestId('discount-apply').click();
  await expect(modal.getByTestId('discount-row')).toHaveCount(1);
  const server = await call<OrderView>('GET', `/orders/${order.id}`, undefined, token);
  expect(server.discounts?.map((d) => d.reason)).toEqual(['Doğum günü']);
  expect(server.grandTotal).toBe(2700);
});

test('paket siparişi gerekçe seçilerek iptal edilir', async ({ page }) => {
  const order = await call<OrderView>('POST', '/orders', { type: 'delivery' }, token);
  await page.goto('/');
  await page.getByTestId(`takeaway-cancel-${order.id}`).click();
  const dialog = page.getByTestId('reason-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Müşteri vazgeçti' }).click();
  await dialog.getByTestId('reason-confirm').click();
  await expect(page.getByTestId(`takeaway-${order.id}`)).toHaveCount(0);
  const server = await call<OrderView>('GET', `/orders/${order.id}`, undefined, token);
  expect(server.status).toBe('cancelled');
});

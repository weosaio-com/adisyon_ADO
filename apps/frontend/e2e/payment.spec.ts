import { test, expect } from '@playwright/test';
import { call, ensureCashOpen, makeFixtures, ownerLogin, type Named } from './api-helpers';

// Odeme penceresi ve kapatma (SAT-1, SAT-2, SAT-21): para ustu sunucudan ve "Tamam"a kadar
// gorunur; kart fazla tahsilat engellenir; toplami 0 adisyon odemesiz kapatilir.
interface OrderView {
  id: string;
  status: string;
  grandTotal: number;
}
interface PaymentRow {
  method: string;
  amount: number;
  received: number;
  change: number;
}

let token = '';
let fx: { categoryId: string; products: Named[]; tables: Named[] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  token = (await ownerLogin()).accessToken;
  await ensureCashOpen(token);
  fx = await makeFixtures(token, { products: [10000], tables: 2 });
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
  return order;
}

test('kısmi nakit ödemede para üstü Tamam’a kadar görünür; kartla fazla tahsilat engellenir', async ({
  page,
}) => {
  const order = await sentOrder(fx.tables[0]!.id);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Ödeme al' }).click();

  // 100 TL'lik adisyonun 60 TL'si nakit, musteri 100 TL verdi: para ustu 40 TL.
  await page.getByTestId('pay-amount').fill('60');
  await page.getByTestId('pay-received').fill('100');
  await expect(page.getByTestId('pay-change')).toContainText('₺40,00');
  await page.getByTestId('pay-submit').click();
  await expect(page.getByTestId('pay-done')).toContainText('₺40,00');
  await expect(page.getByTestId('pay-done-remaining')).toContainText('₺40,00');
  await page.getByRole('button', { name: 'Tamam' }).click();

  // Kalan 40 TL; kartla 50 TL tahsil edilemez.
  await page.getByTestId('pay-method-card').click();
  await page.getByTestId('pay-amount').fill('50');
  await expect(page.getByTestId('pay-overpay')).toBeVisible();
  await expect(page.getByTestId('pay-submit')).toBeDisabled();

  // Nakitte kalandan fazlasi para ustu olur (adisyona yalniz kalan yazilir).
  await page.getByTestId('pay-method-cash').click();
  await page.getByTestId('pay-amount').fill('50');
  await page.getByTestId('pay-submit').click();
  await expect(page.getByTestId('pay-done')).toContainText('₺10,00');
  await page.getByRole('button', { name: 'Tamam' }).click();
  await expect(page).toHaveURL(/\/$/);

  const rows = await call<PaymentRow[]>('GET', `/orders/${order.id}/payments`, undefined, token);
  expect(rows.map((p) => [p.method, p.amount, p.received, p.change])).toEqual([
    ['cash', 6000, 10000, 4000],
    ['cash', 4000, 5000, 1000],
  ]);
});

test('toplamı 0 olan adisyon ödeme alınmadan kapatılır', async ({ page }) => {
  const order = await sentOrder(fx.tables[1]!.id);
  await call(
    'POST',
    `/orders/${order.id}/discounts`,
    { type: 'percent', value: 100, reason: 'İkram' },
    token,
  );
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByRole('button', { name: 'Ödeme al' })).toBeDisabled();
  await page.getByTestId('close-order').click();
  await expect(page).toHaveURL(/\/$/);
  const done = await call<OrderView>('GET', `/orders/${order.id}`, undefined, token);
  expect(done.status).toBe('completed');
});

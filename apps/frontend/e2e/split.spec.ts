import { test, expect } from '@playwright/test';
import { call, ensureCashOpen, makeFixtures, ownerLogin } from './api-helpers';

// SAT-20: bolunen hesap masa planinda / kasada "Gel-al" gorunmez; hangi masadan ayrildigi
// yazilir. Istenirse yeni hesap bos bir masaya acilir.
interface OrderView {
  id: string;
  tableId: string | null;
}

test('bölünen hesap kaynak masasıyla görünür; istenirse boş masaya açılır', async ({ page }) => {
  const token = (await ownerLogin()).accessToken;
  await ensureCashOpen(token);
  const fx = await makeFixtures(token, { products: [1000, 2000, 3000], tables: 2 });
  const [t1, t2] = fx.tables as [{ id: string; name: string }, { id: string; name: string }];
  const order = await call<OrderView>('POST', '/orders', { tableId: t1.id }, token);
  for (const p of fx.products) {
    await call('POST', `/orders/${order.id}/items`, { productId: p.id, quantity: 1000 }, token);
  }

  // 1) Ayni masada ayri hesap: masa planinda "Ayrı hesap · <masa>".
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Böl', exact: true }).click();
  const modal = page.getByTestId('split-modal');
  await modal.getByTestId('split-item').first().click();
  await modal.getByTestId('split-submit').click();
  await expect(page).not.toHaveURL(new RegExp(`/orders/${order.id}$`));
  const separateId = page.url().split('/orders/')[1]!;
  await expect(page.getByText('Ayrı hesap').first()).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId(`takeaway-${separateId}`)).toContainText(`Ayrı hesap · ${t1.name}`);

  // 2) Bos masaya ac: yeni hesap o masada.
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Böl', exact: true }).click();
  await modal.getByTestId('split-item').first().click();
  await modal.getByTestId('split-target').selectOption(t2.id);
  await modal.getByTestId('split-submit').click();
  await expect(page).not.toHaveURL(new RegExp(`/orders/${order.id}$`));
  const moved = await call<OrderView>(
    'GET',
    `/orders/${page.url().split('/orders/')[1]!}`,
    undefined,
    token,
  );
  expect(moved.tableId).toBe(t2.id);
});

import { test, expect } from '@playwright/test';
import { call, ensureCashOpen, makeFixtures, ownerLogin, type Named } from './api-helpers';

// OFF-6 / SAT-6: yaniti kaybolan cevrimici istek tekrar denenince cift kayit olusmaz;
// masa yarisinda (TABLE_HAS_OPEN_ORDER) ikinci cihaz mevcut adisyona gecer.
interface OrderView {
  id: string;
  status: string;
  items: { id: string }[];
}

let token = '';
let fx: { categoryId: string; products: Named[]; tables: Named[] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  token = (await ownerLogin()).accessToken;
  await ensureCashOpen(token);
  fx = await makeFixtures(token, { products: [2000], tables: 3 });
});

test('yanıtı kaybolan ürün ekleme tekrar dokunulunca çift kalem açmaz', async ({ page }) => {
  const order = await call<OrderView>('POST', '/orders', { tableId: fx.tables[0]!.id }, token);
  const product = fx.products[0]!;
  await page.goto(`/orders/${order.id}`);
  await page.getByTestId(`category-${fx.categoryId}`).click();

  // Ilk ekleme sunucuya ulasir, yanit tablete donmez; adisyon tazelemesi bir sure gecikir.
  let first = true;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/orders/*/items', async (route) => {
    if (first && route.request().method() === 'POST') {
      first = false;
      await route.fetch();
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await page.route(`**/api/v1/orders/${order.id}`, async (route) => {
    await held;
    return route.continue();
  });
  await page.getByTestId(`product-${product.id}`).click();
  await expect(page.locator('aside').getByText('ulaşmış olabilir')).toBeVisible();
  // Garson "olmadi" sanip tekrar dokunur: ayni anahtar gider, ikinci kalem acilmaz.
  await page.getByTestId(`product-${product.id}`).click();
  await expect
    .poll(async () => (await call<OrderView>('GET', `/orders/${order.id}`, undefined, token)).items)
    .toHaveLength(1);
  release();
  await expect(page.getByTestId('order-item')).toHaveCount(1);

  // Ekranda kalem gorunduktan sonraki dokunus bilerek yapilir: yeni kalem acar.
  await page.getByTestId(`product-${product.id}`).click();
  await expect(page.getByTestId('order-item')).toHaveCount(2);
});

test('yanıtı kaybolan masa açma tekrar dokunulunca ikinci adisyon açmaz', async ({ page }) => {
  const table = fx.tables[1]!;
  await page.goto('/');
  let first = true;
  await page.route('**/api/v1/orders', async (route) => {
    if (first && route.request().method() === 'POST') {
      first = false;
      await route.fetch();
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await page.getByTestId(`table-${table.id}`).click();
  await expect(page.getByTestId('tables-notice')).toContainText('ulaşmış olabilir');
  await page.getByTestId(`table-${table.id}`).click();
  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  const open = await call<OrderView[]>(
    'GET',
    `/orders?tableId=${table.id}&open=true`,
    undefined,
    token,
  );
  expect(open).toHaveLength(1);
  expect(page.url()).toContain(open[0]!.id);
});

test('masayı başka cihaz aynı anda açtıysa o adisyona geçilir', async ({ page }) => {
  const table = fx.tables[2]!;
  // Canli olay akisi kapali: masa plani bayat kalir (yaris ani).
  await page.route('**/api/v1/events/stream', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByTestId(`table-${table.id}`)).toContainText('Siparişe hazır');
  const other = await call<OrderView>('POST', '/orders', { tableId: table.id }, token);
  await page.getByTestId(`table-${table.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${other.id}$`));
});

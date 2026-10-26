import { test, expect } from '@playwright/test';
import {
  call,
  ensureCashOpen,
  makeFixtures,
  makeWaiter,
  ownerLogin,
  sessionContext,
} from './api-helpers';

// OFF-16: canli akis koptuktan sonra yeniden baglaninca kacirilan degisiklikler tazelenir.
// OFF-13: tablet depolamasi dolmak uzereyken garson uyarilir. URN-17: kasa kapaliyken garsona
// ne yapacagi yazilir.
let token = '';

test.beforeAll(async () => {
  token = (await ownerLogin()).accessToken;
  await ensureCashOpen(token);
});

test('canlı akış koptuktan sonra bağlanınca kaçırılan adisyon görünür', async ({ page }) => {
  const fx = await makeFixtures(token, { products: [1500], tables: 1 });
  const table = fx.tables[0]!;
  let streams = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/events/stream', async (route) => {
    streams += 1;
    if (streams === 1) return route.abort('connectionreset'); // Wi-Fi dolasimi: akis koptu
    await held; // yeniden baglanti, degisiklik olduktan sonra kurulur
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByTestId(`table-${table.id}`)).toContainText('Siparişe hazır');
  await expect.poll(() => streams, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  // Akis kopukken baska cihaz masayi acar (olay bu tablete ulasmaz).
  await call('POST', '/orders', { tableId: table.id }, token);
  release();
  // Masa plani 30 sn'lik yoklamayi beklemeden tazelenir.
  await expect(page.getByTestId(`table-${table.id}`)).toContainText('Aktif adisyon', {
    timeout: 10_000,
  });
});

test('tablet depolaması dolmak üzereyken uyarı gösterilir', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persist: async () => true,
        estimate: async () => ({ usage: 92, quota: 100 }),
      },
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('storage-warning')).toContainText('%92');
});

test('kasa kapalıyken garsona yöneticiden kasayı açmasını istemesi söylenir', async ({
  browser,
}) => {
  const fx = await makeFixtures(token, { products: [1500], tables: 1 });
  const waiter = await makeWaiter(token);
  const context = await sessionContext(browser, waiter.login);
  const page = await context.newPage();
  await page.route('**/api/v1/cash/status', (route) =>
    route.fulfill({ json: { success: true, data: { open: false } } }),
  );
  await page.goto('/');
  await expect(page.getByText('yöneticinizden kasayı açmasını isteyin').first()).toBeVisible();
  await page.getByTestId(`table-${fx.tables[0]!.id}`).click();
  await expect(page.getByTestId('tables-notice')).toContainText(
    'yöneticinizden kasayı açmasını isteyin',
  );
  await context.close();
});

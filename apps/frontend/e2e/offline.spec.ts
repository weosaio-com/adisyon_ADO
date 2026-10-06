import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// global-setup uretir; test kosum aninda okunur (module-top'ta DEGIL: setup'tan once import edilir).
function fixtures() {
  return JSON.parse(readFileSync(join(here, '.fixtures.json'), 'utf8')) as {
    categoryId: string;
    productId: string;
    productName: string;
    tableId: string;
    tableName: string;
  };
}

// Offline reboot'ta katalog gozuksun diye snapshot cache'i IndexedDB'ye yazilmis olmali.
async function waitForSnapshot(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const req = indexedDB.open('ado-offline');
              req.onsuccess = () => {
                try {
                  const g = req.result
                    .transaction('meta', 'readonly')
                    .objectStore('meta')
                    .get('snapshot');
                  g.onsuccess = () =>
                    resolve(Boolean((g.result as { data?: unknown } | undefined)?.data));
                  g.onerror = () => resolve(false);
                } catch {
                  resolve(false);
                }
              };
              req.onerror = () => resolve(false);
            }),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

test('offline siparis alma + yenileme kaliciligi + reconnect senkron (kayipsiz)', async ({
  page,
  context,
}) => {
  const f = fixtures();

  await page.goto('/');
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'online');
  await waitForSnapshot(page);
  // Service worker sayfayi kontrol etsin -> offline yenileme app-shell'den acilir.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, {
    timeout: 15_000,
  });

  // --- CEVRIMDISI: baglanti kop ---
  await context.setOffline(true);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'offline');

  // masa ac (offline -> local draft)
  await page.getByTestId(`table-${f.tableId}`).click();
  await expect(page).toHaveURL(/\/orders\/local:/);

  // urun ekle (optimistic, outbox'a yazilir) — once kategori sekmesi
  await page.getByTestId(`category-${f.categoryId}`).click();
  await page.getByTestId(`product-${f.productId}`).click();
  await expect(page.getByTestId('order-item')).toHaveCount(1);
  await expect(page.locator('aside').getByText(f.productName)).toBeVisible();

  // Odeme ana bilgisayarda: baglanti yokken alinmaz ve nedeni yazilir (siparis saklanir).
  const pay = page.getByRole('button', { name: 'Ödeme al' });
  await expect(pay).toBeDisabled();
  await expect(page.getByTestId('pay-offline-hint')).toContainText(
    'Ödeme için ana bilgisayara bağlantı gerekir',
  );

  // mutfaga gonder (offline)
  await page.getByTestId('send-kitchen').click();

  // --- YENILEME: tablet kapanip acilsa bile veri IndexedDB'de kalir ---
  await page.reload();
  await expect(page).toHaveURL(/\/orders\/local:/);
  await expect(page.getByTestId('order-item')).toHaveCount(1);
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'offline');

  // --- RECONNECT: outbox drain + gercek adisyona yonlendirme ---
  await context.setOffline(false);
  await expect(page).toHaveURL(/\/orders\/(?!local:)[^/]+$/, { timeout: 20_000 });
  await expect(page.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'online', {
    timeout: 20_000,
  });
  // sunucu adisyonu offline kalemi tasidi (kayipsiz)
  await expect(page.getByTestId('order-item')).toHaveCount(1);
  // Baglanti geldi: odeme alinabilir, uyari kalkar.
  await expect(page.getByTestId('pay-offline-hint')).toHaveCount(0);
  await expect(pay).toBeEnabled();
});

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, ensureCashOpen, makeFixtures, ownerLogin, waitOfflineReady } from './api-helpers';

// OFF-7: yeni surum acik tablete ulasir. Garson yarim isteyken (adisyon ekrani) sayfa
// kendiliginden yenilenmez, "Yeni sürüm hazır" seridi cikar; masa planina donunce (guvenli an)
// uygulama kendiliginden yeni surume gecer. "Yeni surum": sunucudaki sw.js degisir.
const here = dirname(fileURLToPath(import.meta.url));
const SW = join(here, '..', 'dist', 'sw.js');

declare global {
  interface Window {
    __eskiSayfa?: boolean;
  }
}

test('yeni sürüm açık tablete ulaşır: yarım işte şerit, güvenli anda kendiliğinden yenilenir', async ({
  page,
}) => {
  const token = (await ownerLogin()).accessToken;
  await ensureCashOpen(token);
  const fx = await makeFixtures(token, { products: [1500], tables: 1 });
  const order = await call<{ id: string }>('POST', '/orders', { tableId: fx.tables[0]!.id }, token);
  await page.goto('/');
  await waitOfflineReady(page);
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId('order-title')).toBeVisible();
  await page.evaluate(() => (window.__eskiSayfa = true));

  const original = readFileSync(SW, 'utf8');
  try {
    writeFileSync(SW, `${original}\n// e2e yeni surum ${Date.now()}\n`);
    // Tablet one gelince guncelleme yoklanir (ayrica saatte bir).
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.__eskiSayfa)).toBe(true);

    // Masa planina donunce guvenli an: yeni surum etkinlesir, sayfa kendiliginden yenilenir.
    const reloaded = page.waitForEvent('load', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Masa planına dön' }).click();
    await reloaded;
    expect(await page.evaluate(() => window.__eskiSayfa ?? null)).toBeNull();
    await expect(page.getByTestId('update-banner')).toHaveCount(0);
    await expect(page.getByTestId('sync-badge')).toBeVisible();
  } finally {
    writeFileSync(SW, original);
  }
});

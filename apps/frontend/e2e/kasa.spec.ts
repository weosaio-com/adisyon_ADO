import { test, expect } from '@playwright/test';
import { call, ensureCashOpen, ownerLogin } from './api-helpers';

// Kasa ekrani: elle kasa hareketi (aciklama zorunlu, tekrar korumasi).
interface ActiveSession {
  id: string;
  transactions: { type: string; amount: number; note?: string | null }[];
}

let token = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  token = (await ownerLogin()).accessToken;
  await ensureCashOpen(token);
});

// Kapanis testi kasayi kapatir: sonraki spec'ler acik kasa bekler.
test.afterAll(async () => {
  await ensureCashOpen(token);
});

test('kasa hareketi açıklama ister; yanıtı kaybolan istek tekrar basılınca çiftlenmez', async ({
  page,
}) => {
  await page.goto('/cash');
  const note = `E2E bozuk para ${Date.now()}`;
  await page.getByRole('button', { name: 'Para Çıkışı' }).click();
  await page.getByTestId('cash-move-amount').fill('50');
  await expect(page.getByTestId('cash-move-submit')).toBeDisabled();
  await page.getByTestId('cash-move-note').fill(note);

  // Ilk istek sunucuya ulasir ve islenir, yanit tablete donmez (Wi-Fi kopmasi).
  let first = true;
  await page.route('**/api/v1/cash/transactions', async (route) => {
    if (first && route.request().method() === 'POST') {
      first = false;
      await route.fetch();
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await page.getByTestId('cash-move-submit').click();
  await expect(page.getByText('kaydedilmiş olabilir')).toBeVisible();
  await page.getByTestId('cash-move-submit').click();
  await expect(page.getByTestId('cash-move-note')).toHaveValue('');

  const active = await call<ActiveSession>('GET', '/cash/sessions/active', undefined, token);
  const mine = active.transactions.filter((t) => t.note === note);
  expect(mine.map((t) => [t.type, t.amount])).toEqual([['payout', -5000]]);
});

test('kasa kapanışı onay ister; kapanıştan sonra gün sonu özeti görünür', async ({ page }) => {
  // Acik adisyon varken kasa kapanmaz: test verisi temizlenir (sonraki spec'ler kendi verisini kurar).
  for (const query of ['open=true', 'status=held']) {
    for (const order of await call<{ id: string }[]>('GET', `/orders?${query}`, undefined, token)) {
      await call('POST', `/orders/${order.id}/cancel`, { reason: 'e2e kasa kapanışı' }, token);
    }
  }
  await page.goto('/cash');
  await page.getByTestId('cash-count').fill('12,34');
  await page.getByTestId('cash-close').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('Kasa kapatılsın mı?');
  await expect(dialog).toContainText('Beklenen nakit');
  await expect(dialog).toContainText('Sayılan ₺12,34');
  // Vazgecince kasa acik kalir (tek dokunusla gun kapanmaz).
  await dialog.getByTestId('confirm-dialog-cancel').click();
  expect((await call<{ open: boolean }>('GET', '/cash/status', undefined, token)).open).toBe(true);

  await page.getByTestId('cash-close').click();
  await dialog.getByTestId('confirm-dialog-confirm').click();
  const summary = page.getByTestId('day-end-summary');
  await expect(summary).toContainText('Gün sonu özeti');
  await expect(summary).toContainText('₺12,34');
  await expect(summary.getByTestId('day-end-difference')).toBeVisible();
  expect((await call<{ open: boolean }>('GET', '/cash/status', undefined, token)).open).toBe(false);
  await summary.getByRole('button', { name: 'Tamam' }).click();
  await expect(page.getByText('Kasa Kapalı')).toBeVisible();
});

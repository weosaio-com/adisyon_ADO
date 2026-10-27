import { test, expect } from '@playwright/test';
import {
  call,
  ensureCashOpen,
  idbCount,
  makeFixtures,
  makeWaiter,
  ownerLogin,
  sessionContext,
  waitOfflineReady,
} from './api-helpers';

// OFF-2 + OFF-8: onaya dusen cevrimdisi siparis onay ekraninda TEK kart; tek kararla secilen
// masada tek adisyon olarak uygulanir ve mutfaga gider. Tablet sonucu ogrenir: taslak sunucu
// adisyonuna baglanir (hayalet "Senkron bekliyor" kalmaz) ya da reddedilince garsona bildirilir.
interface OrderView {
  id: string;
  tableId: string | null;
  items: { status: string }[];
}

test('onaya düşen sipariş tek kararla uygulanır ya da reddedilir; tablet sonucu görür', async ({
  browser,
  page,
}) => {
  test.setTimeout(150_000);
  const owner = (await ownerLogin()).accessToken;
  await ensureCashOpen(owner);
  const fx = await makeFixtures(owner, { products: [1500, 2500], tables: 3 });
  const [p1, p2] = fx.products as [{ id: string; name: string }, { id: string; name: string }];
  const [t1, t2, t3] = fx.tables as [
    { id: string; name: string },
    { id: string; name: string },
    { id: string; name: string },
  ];
  const waiter = await makeWaiter(owner, 'Onay Garsonu');
  const context = await sessionContext(browser, waiter.login);
  const tablet = await context.newPage();
  await tablet.goto('/');
  await waitOfflineReady(tablet);

  // Tablet cevrimdisiyken siparis alir; bu arada masa kasada silinir (masa yok -> onay).
  const offlineOrder = async (tableId: string, productId: string) => {
    await context.setOffline(true);
    await expect(tablet.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'offline');
    await tablet.getByTestId(`table-${tableId}`).click();
    await expect(tablet).toHaveURL(/\/orders\/local:/);
    await tablet.getByTestId(`category-${fx.categoryId}`).click();
    await tablet.getByTestId(`product-${productId}`).click();
    await tablet.getByTestId('send-kitchen').click();
    await tablet.getByRole('button', { name: 'Masa planına dön' }).click();
    await call('DELETE', `/tables/${tableId}`, undefined, owner);
    await context.setOffline(false);
    await expect(tablet.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'degraded', {
      timeout: 30_000,
    });
  };

  // --- 1) Uygula: tek kart, asil masa yok -> baska masa secilir; tek adisyon, mutfakta.
  await offlineOrder(t1.id, p1.id);
  await page.goto('/offline-reviews');
  const card = page.getByTestId('review-group').filter({ hasText: p1.name });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Masa silinmiş');
  await expect(card).toContainText('Onay Garsonu');
  await expect(card).toContainText('mutfağa göndermişti');
  await expect(card.getByTestId('review-apply')).toBeDisabled();
  await card.getByTestId('review-table-select').selectOption(t2.id);
  await card.getByTestId('review-apply').click();
  await expect(card).toHaveCount(0);
  const orders = await call<OrderView[]>(
    'GET',
    `/orders?tableId=${t2.id}&open=true`,
    undefined,
    owner,
  );
  expect(orders).toHaveLength(1);
  expect(orders[0]!.items.map((i) => i.status)).toEqual(['sent']);

  // Tablet: onay sonucu geldi, sorunlar duser; taslak sunucu adisyonuna baglandi.
  await expect(tablet.getByTestId('sync-badge')).toHaveAttribute('data-mode', 'online', {
    timeout: 30_000,
  });
  await expect(tablet.getByTestId(`table-${t2.id}`)).toContainText('Aktif adisyon', {
    timeout: 30_000,
  });

  // --- 2) Reddet: onay penceresi ister; tablet "yönetici reddetti" gorur, taslak silinir.
  await offlineOrder(t3.id, p2.id);
  await page.reload();
  const card2 = page.getByTestId('review-group').filter({ hasText: p2.name });
  await card2.getByTestId('review-reject').click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toContainText('Sipariş reddedilsin mi?');
  await confirm.getByTestId('confirm-dialog-confirm').click();
  await expect(card2).toHaveCount(0);

  await tablet.getByTestId('sync-badge').click();
  const panel = tablet.getByTestId('sync-panel');
  await expect(panel.getByTestId('sync-problem').first()).toContainText('yönetici reddetti', {
    timeout: 30_000,
  });
  await expect.poll(() => idbCount(tablet, 'drafts'), { timeout: 15_000 }).toBeLessThanOrEqual(1);
  await context.close();
});

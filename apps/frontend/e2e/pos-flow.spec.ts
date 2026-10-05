import { test, expect, type Browser, type Page } from '@playwright/test';
import { networkInterfaces } from 'node:os';

// Basit surumun ana senaryosu, gercek tarayicida: garson tabletten siparis girer,
// mutfak fisi masa/garson/not ile cikar, kasa parcali odemeyi para ustuyle alir.
// Verisini API ile kendisi kurar; offline/https-lan spec'lerinin fixture'larina dokunmaz.
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${ORIGIN}/api/v1`;
const OWNER = {
  username: process.env.SEED_OWNER_USERNAME ?? 'owner',
  password: process.env.SEED_OWNER_PASSWORD ?? 'owner1234',
};
const TABLET = { width: 820, height: 1180 };
const PHONE = { width: 390, height: 844 };

interface Named {
  id: string;
  name: string;
}
interface PrintJob {
  documentType: string;
  summary: string;
  status: string;
  text: string;
}
interface Payment {
  method: string;
  direction: string;
  amount: number;
  received: number;
  change: number;
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T } & Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return (json.data ?? json) as T;
}

function lanIp(): string | undefined {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) if (net.family === 'IPv4' && !net.internal) return net.address;
  }
  return undefined;
}

const fx = {} as {
  token: string;
  hall: string;
  categoryId: string;
  kofte: Named;
  ayran: Named;
  tables: Record<'a' | 'b' | 'c' | 'd' | 'e', Named>;
  printerName: string;
  waiter: { id: string; username: string; displayName: string; pin: string };
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fx.token = (await call<{ accessToken: string }>('POST', '/auth/login', OWNER)).accessToken;
  const t = fx.token;
  const tag = Date.now();
  const unit = await call<Named>('POST', '/units', { name: `Adet${tag}`, abbreviation: 'ad' }, t);
  const tax = await call<Named>('POST', '/taxes', { name: `KDV${tag}`, ratePermille: 100 }, t);
  const cat = await call<Named>('POST', '/categories', { name: `E2E Izgara ${tag}` }, t);
  fx.categoryId = cat.id;
  const product = (name: string, salePrice: number) =>
    call<Named>(
      'POST',
      '/products',
      { name, categoryId: cat.id, unitId: unit.id, taxId: tax.id, salePrice },
      t,
    );
  fx.kofte = await product(`E2E Köfte ${tag}`, 14500);
  fx.ayran = await product(`E2E Ayran ${tag}`, 3000);
  fx.hall = `E2E Bahçe ${tag}`;
  const hall = await call<Named>('POST', '/halls', { name: fx.hall }, t);
  const table = (name: string) => call<Named>('POST', '/tables', { hallId: hall.id, name }, t);
  fx.tables = {
    a: await table('Masa 1'),
    b: await table('Masa 2'),
    c: await table('Masa 3'),
    d: await table('Masa 4'),
    e: await table('Masa 5'),
  };
  fx.printerName = `E2E Mutfak ${tag}`;
  // PIN aktif kullanicilar arasinda benzersiz olmali (PIN_TAKEN); cakisirsa yeniden dene.
  for (let attempt = 0; !fx.waiter; attempt++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    const username = `garson-e2e-${tag}`;
    try {
      const user = await call<{ id: string }>(
        'POST',
        '/users',
        { username, displayName: 'E2E Garson', role: 'waiter', pin },
        t,
      );
      fx.waiter = { id: user.id, username, displayName: 'E2E Garson', pin };
    } catch (err) {
      if (attempt > 3 || !String(err).includes('PIN_TAKEN')) throw err;
    }
  }
});

test.afterAll(async () => {
  if (fx.waiter)
    await call('DELETE', `/users/${fx.waiter.id}`, undefined, fx.token).catch(() => {});
});

async function login(page: Page, origin: string, kind: 'owner' | 'waiter') {
  await page.goto(`${origin}/login`);
  await page.getByRole('button', { name: kind === 'owner' ? 'Yönetici' : 'Garson' }).click();
  await page
    .locator('input[autocomplete="username"]')
    .fill(kind === 'owner' ? OWNER.username : fx.waiter.username);
  await page
    .locator('input[type="password"]')
    .fill(kind === 'owner' ? OWNER.password : fx.waiter.pin);
  await page.getByRole('button', { name: 'Sisteme giriş yap' }).click();
  await expect(page).toHaveURL(`${origin}/`);
}

async function waiterPage(browser: Browser, viewport = TABLET): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await login(page, ORIGIN, 'waiter');
  return page;
}

async function findJob(match: (job: PrintJob) => boolean): Promise<PrintJob | undefined> {
  const jobs = await call<PrintJob[]>('GET', '/printers/jobs', undefined, fx.token);
  return jobs.find(match);
}

test('yönetici yazıcıyı ekler, mutfak fişini yönlendirir ve test sayfası basar', async ({
  page,
}) => {
  await page.goto('/settings');
  const card = page.getByTestId('printer-card');
  await card.getByRole('button', { name: '+ Yazıcı ekle' }).click();
  // Gelistirme/CI surucusu: fisi loga yazar (gercek yazicida Windows'taki yazici secilir).
  await card
    .getByTestId('printer-pick')
    .selectOption({ label: 'Simülasyon yazıcı (fiş loga yazılır)' });
  await card.getByPlaceholder('Görünen ad').fill(fx.printerName);
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: 'Kaydet' }).click();
  const row = card.getByTestId('printer-row').filter({ hasText: fx.printerName });
  await expect(row.getByText('Varsayılan', { exact: true })).toBeVisible();

  await card.getByTestId('route-kitchen').selectOption({ label: fx.printerName });
  await expect
    .poll(async () => {
      const routes = await call<
        { documentType: string; categoryId: string | null; printer: Named }[]
      >('GET', '/printers/routes', undefined, fx.token);
      return routes.some(
        (r) => r.documentType === 'kitchen' && !r.categoryId && r.printer.name === fx.printerName,
      );
    })
    .toBe(true);

  await row.getByRole('button', { name: 'Test yazdır' }).click();
  await expect(
    card.getByTestId('print-jobs').locator('li').filter({ hasText: 'YAZICI TEST SAYFASI' }).first(),
  ).toContainText('Yazdırıldı', { timeout: 20_000 });
});

test('garson tabletten sipariş girer, not ekler ve mutfağa gönderir', async ({ browser }) => {
  const waiter = await waiterPage(browser);
  await waiter.getByTestId(`table-${fx.tables.a.id}`).click();
  await expect(waiter.getByTestId('order-title')).toHaveText(fx.tables.a.name);

  await waiter.getByTestId(`category-${fx.categoryId}`).click();
  await waiter.getByTestId(`product-${fx.kofte.id}`).click();
  await expect(waiter.getByTestId('order-item')).toHaveCount(1);
  await waiter.getByTestId('order-item').first().getByRole('button', { name: 'Artır' }).click();
  await expect(waiter.getByTestId('order-item').first()).toContainText('₺290,00');
  await waiter.getByTestId(`product-${fx.ayran.id}`).click();
  await expect(waiter.getByTestId('order-item')).toHaveCount(2);

  await waiter.getByTestId('order-item').first().getByTestId('item-note-button').click();
  const note = waiter.getByRole('dialog', { name: 'Ürün notu' });
  await note.getByRole('textbox').fill('az pişmiş');
  await note.getByRole('button', { name: 'Kaydet' }).click();
  await expect(waiter.getByTestId('item-note')).toHaveText('Not: az pişmiş');

  // Odeme kasada: garson "Ödeme al" gormez.
  await expect(waiter.getByRole('button', { name: 'Ödeme al' })).toHaveCount(0);
  await waiter.getByTestId('send-kitchen').click();
  await expect(waiter.getByText('Mutfağa gönderildi')).toHaveCount(2);

  const place = `${fx.hall} · ${fx.tables.a.name}`;
  await expect
    .poll(
      async () =>
        (await findJob((j) => j.documentType === 'kitchen' && j.summary.includes(place)))?.text,
      {
        timeout: 15_000,
      },
    )
    .toContain(`Masa: ${place}`);
  const ticket = (await findJob((j) => j.documentType === 'kitchen' && j.summary.includes(place)))!;
  expect(ticket.text).toContain(`Garson: ${fx.waiter.displayName}`);
  expect(ticket.text).toContain(`2 x ${fx.kofte.name}\r\n   Not: az pişmiş`);
  await waiter.context().close();
});

// Sayfa yana kaymasin (telefon): belge genisligi ekran genisligini asmaz.
async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

test('garson telefondan (390 px) sipariş girer ve mutfağa gönderir', async ({ browser }) => {
  const waiter = await waiterPage(browser, PHONE);
  await expectNoHorizontalScroll(waiter);
  await waiter.getByTestId(`table-${fx.tables.e.id}`).click();
  await expect(waiter.getByTestId('order-title')).toHaveText(fx.tables.e.name);

  // Telefonda urunler tam ekran; adisyon alttaki seritte ozetlenir.
  await waiter.getByTestId(`category-${fx.categoryId}`).click();
  await waiter.getByTestId(`product-${fx.kofte.id}`).click();
  await expect(waiter.getByTestId('show-order')).toContainText('1 kalem');
  await waiter.getByTestId(`product-${fx.ayran.id}`).click();
  const summary = waiter.getByTestId('show-order');
  await expect(summary).toContainText('2 kalem · 2 mutfağa gönderilmedi');
  await expect(summary).toContainText('₺175,00');
  await expectNoHorizontalScroll(waiter);

  await summary.click();
  await expect(waiter.getByTestId('order-item')).toHaveCount(2);
  await expect(waiter.getByTestId(`product-${fx.kofte.id}`)).toBeHidden();
  await expectNoHorizontalScroll(waiter);
  await waiter.getByTestId('send-kitchen').click();
  await expect(waiter.getByText('Mutfağa gönderildi')).toHaveCount(2);

  // Urun eklemeye donulur.
  await waiter.getByTestId('show-products').click();
  await expect(waiter.getByTestId(`product-${fx.kofte.id}`)).toBeVisible();
  await expect(waiter.getByTestId('show-order')).toContainText('2 kalem');
  await expect(waiter.getByTestId('show-order')).not.toContainText('gönderilmedi');
  await waiter.context().close();
});

test('Ayarlar: tablet ve telefon için kurulum QR kodları ve WiFi yönergesi', async ({ page }) => {
  test.skip(!lanIp(), 'LAN IPv4 yok');
  const info = await call<{ urls: string[]; httpsUrls: string[]; caUrls: string[] }>(
    'GET',
    '/devices/server-info',
    undefined,
    fx.token,
  );
  await page.goto('/settings');
  // HTTPS aciksa once sertifika, sonra adisyon; degilse yalniz adisyon adresi.
  const qr = page.getByTestId('server-qr');
  await expect(qr.locator('img')).toHaveCount(info.caUrls.length > 0 ? 2 : 1);
  await expect(qr.locator('img').last()).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(qr).toContainText('Adisyonu aç');
  const help = page.getByTestId('no-wifi-help');
  await help.locator('summary').click();
  await expect(help).toContainText('Android');
});

test('kasa parçalı ödeme alır: kart + nakit, para üstü doğru kaydedilir', async ({ page }) => {
  await page.goto('/');
  // Garsonun siparisi masa planinda gorunur (320 TL).
  await expect(page.getByTestId(`table-${fx.tables.a.id}`)).toContainText('₺320,00');
  await page.getByTestId(`table-${fx.tables.a.id}`).click();
  await expect(page).toHaveURL(/\/orders\//);
  const orderId = page.url().split('/orders/')[1]!;
  await expect(page.getByTestId('item-note')).toHaveText('Not: az pişmiş');

  await page.getByRole('button', { name: 'Ödeme al' }).click();
  await page.getByTestId('pay-method-card').click();
  await page.getByTestId('pay-amount').fill('100');
  await page.getByTestId('pay-submit').click();
  await expect(page.getByTestId('pay-submit')).toHaveText('₺220,00 Öde');

  await page.getByTestId('pay-method-cash').click();
  await page.getByRole('button', { name: '+200' }).click();
  await page.getByRole('button', { name: '+50' }).click();
  await expect(page.getByTestId('pay-change')).toContainText('₺30,00');
  await page.getByTestId('pay-submit').click();
  await expect(page.getByTestId('pay-done')).toContainText('₺30,00');
  await page.getByRole('button', { name: 'Tamam' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId(`table-${fx.tables.a.id}`)).toContainText('Siparişe hazır');

  // Kasaya verilen 250 TL degil, adisyona dusen 220 TL satis yazilir; para ustu ayri.
  const payments = await call<Payment[]>('GET', `/orders/${orderId}/payments`, undefined, fx.token);
  expect(payments.map((p) => [p.method, p.amount, p.received, p.change])).toEqual([
    ['card', 10000, 10000, 0],
    ['cash', 22000, 25000, 3000],
  ]);
  await expect
    .poll(
      async () =>
        (
          await findJob(
            (j) =>
              j.documentType === 'customer' &&
              j.text.includes('ÖDENDİ') &&
              j.summary.includes(`${fx.hall} · ${fx.tables.a.name}`),
          )
        )?.text,
      { timeout: 15_000 },
    )
    .toContain('Kart: 100,00 TL\r\nNakit: 220,00 TL\r\nPara üstü: 30,00 TL');
});

test('garson yanlışlıkla açtığı boş masayı kapatır', async ({ browser }) => {
  const waiter = await waiterPage(browser);
  await waiter.getByTestId(`table-${fx.tables.b.id}`).click();
  await expect(waiter.getByTestId('order-title')).toHaveText(fx.tables.b.name);
  await waiter.getByTestId('discard-order').click();
  await expect(waiter).toHaveURL(/\/$/);
  await expect(waiter.getByTestId(`table-${fx.tables.b.id}`)).toContainText('Siparişe hazır');
  await waiter.context().close();
});

test('yanlış yöntemle alınan ödeme kasadan iade edilip doğru yöntemle alınır', async ({ page }) => {
  const order = await call<{ id: string; orderNo: string }>(
    'POST',
    '/orders',
    { tableId: fx.tables.c.id },
    fx.token,
  );
  await call(
    'POST',
    `/orders/${order.id}/items`,
    { productId: fx.ayran.id, quantity: 1000 },
    fx.token,
  );
  const paid = await call<{ payments: { id: string }[] }>(
    'POST',
    `/orders/${order.id}/payments`,
    { method: 'card', amount: 3000, idempotencyKey: `e2e-wrong-${Date.now()}` },
    fx.token,
  );

  await page.goto('/cash');
  await page.getByTestId(`refund-${paid.payments[0]!.id}`).click();
  const dialog = page.getByRole('dialog', { name: 'Ödemeyi iade et' });
  await dialog.getByRole('button', { name: 'Yanlış ödeme yöntemi' }).click();
  await dialog.getByRole('button', { name: 'İade et' }).click();
  await expect(page.getByText('İade yapıldı')).toBeVisible();
  await page.getByRole('button', { name: 'Adisyonu aç' }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${order.id}$`));

  await page.getByRole('button', { name: 'Ödeme al' }).click();
  await expect(page.getByTestId('pay-submit')).toHaveText('₺30,00 Öde');
  await page.getByTestId('pay-submit').click();
  await expect(page).toHaveURL(/\/$/);
  const done = await call<{ status: string }>('GET', `/orders/${order.id}`, undefined, fx.token);
  expect(done.status).toBe('completed');

  // Otomatik fis adisyon basina bir kez basilir; duzeltilmis fis kasadan elle basilir.
  const payments = await call<(Payment & { id: string })[]>(
    'GET',
    `/orders/${order.id}/payments`,
    undefined,
    fx.token,
  );
  const cash = payments.find((p) => p.method === 'cash' && p.direction === 'charge')!;
  await page.goto('/cash');
  await page.getByTestId(`reprint-${cash.id}`).click();
  await expect(page.getByText('fişi yazıcıya gönderildi')).toBeVisible();
  await expect
    .poll(
      async () =>
        (await findJob((j) => j.text.includes('(tekrar)') && j.summary.endsWith(order.orderNo)))
          ?.text,
      { timeout: 15_000 },
    )
    .toContain('Nakit: 30,00 TL');
});

test('HTTP LAN adresinden (güvensiz bağlam) ödeme alınır', async ({ browser }) => {
  const ip = lanIp();
  test.skip(!ip, 'LAN IPv4 yok');
  const origin = `http://${ip}:${new URL(ORIGIN).port || '80'}`;
  const order = await call<{ id: string }>(
    'POST',
    '/orders',
    { tableId: fx.tables.d.id },
    fx.token,
  );
  await call(
    'POST',
    `/orders/${order.id}/items`,
    { productId: fx.ayran.id, quantity: 1000 },
    fx.token,
  );

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await login(page, origin, 'owner');
  // crypto.randomUUID burada yok; eskiden "Ödeme başarısız." cikardi.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await page.goto(`${origin}/orders/${order.id}`);
  await page.getByRole('button', { name: 'Ödeme al' }).click();
  await page.getByTestId('pay-method-card').click();
  await page.getByTestId('pay-submit').click();
  await expect(page).toHaveURL(`${origin}/`);
  const done = await call<{ status: string }>('GET', `/orders/${order.id}`, undefined, fx.token);
  expect(done.status).toBe('completed');
  await context.close();
});

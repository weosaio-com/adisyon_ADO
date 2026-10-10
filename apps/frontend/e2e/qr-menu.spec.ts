import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildPayload, signLicense } from '../../../scripts/license.mjs';

// QR menu uctan uca: POS (:3001) + bulut (apps/cloud, `wrangler dev`). Bulut adresi
// E2E_CLOUD_URL ile verilir; verilmezse bu dosya calismaz (playwright.config testIgnore).
// CI'da e2e-cloud isi kosar. Satici API anahtari bulutun ADMIN_TOKEN'i ile ayni olmali.
// POS'lu akis lisansla acilir: test lisansi ADO_LICENSE_PRIVATE_KEY_FILE ile imzalanir; acik
// anahtari POS (ADO_LICENSE_PUBLIC_KEY) ve bulut (LICENSE_PUBLIC_KEY) bilir. POS'un gomulu bulut
// adresi (CLOUD_API_URL) E2E_CLOUD_URL ile ayni olmali.
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${ORIGIN}/api/v1`;
const CLOUD = process.env.E2E_CLOUD_URL ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.E2E_CLOUD_ADMIN_TOKEN ?? '';
const LICENSE_KEY_FILE = process.env.ADO_LICENSE_PRIVATE_KEY_FILE ?? '';
const OWNER = {
  username: process.env.SEED_OWNER_USERNAME ?? 'owner',
  password: process.env.SEED_OWNER_PASSWORD ?? 'owner1234',
};

interface Named {
  id: string;
  name: string;
}

// Gorsel govdesi (Uint8Array) octet-stream, digerleri JSON gider.
async function pos<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const binary = body instanceof Uint8Array;
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': binary ? 'application/octet-stream' : 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body instanceof Uint8Array
      ? { body: new Uint8Array(body) }
      : body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T } & Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return (json.data ?? json) as T;
}

// Satici API'si ile isletme ac (kendi kendine kayit sonraki asamada).
async function newTenant(name: string) {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const password = 'e2e-parola-12345';
  const res = await fetch(`${CLOUD}/api/admin/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ name, plan: 'menu', owner: { email, password } }),
  });
  if (res.status !== 201) throw new Error(`tenant -> ${res.status} ${await res.text()}`);
  return { email, password };
}

// Saticinin imzaladigi test lisansi (QR menu dahil); her kosumda yeni lisans kimligi.
function e2eLicense(customer: string): string {
  return signLicense(
    buildPayload({
      id: `lic_e2e_${Date.now()}`,
      customer,
      exp: '2099-01-01',
      features: { 'qr.menu': true },
    }),
    readFileSync(LICENSE_KEY_FILE, 'utf8'),
  );
}

// Musteri telefonu (390 px) ve isletme sahibi paneli ayni bulut adresinde; her testin
// sonunda kapatilir.
const contexts: BrowserContext[] = [];
async function phone(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'tr-TR',
  });
  contexts.push(context);
  return context.newPage();
}

async function panelLogin(page: Page, user: { email: string; password: string }) {
  await page.goto(`${CLOUD}/panel`);
  await page.getByLabel('E-posta').fill(user.email);
  await page.getByLabel('Parola').fill(user.password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByTestId('panel-tenant')).toBeVisible();
}

// Fotograf yerine tarayicida gorsel uretilir: arayuze buyuk PNG (tarayici kucultur), API'ye
// dogrudan yukleme icin kucultulmus hali (800 px WebP; POS arayuzunun gonderdigi bicim).
async function photo(page: Page, width: number, type: 'image/png' | 'image/webp') {
  const dataUrl = await page.evaluate(
    ([w, t]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = (w * 3) / 4;
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, '#f59e0b');
      gradient.addColorStop(1, '#7c2d12');
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL(t, 0.8);
    },
    [width, type] as const,
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function expectImageLoaded(page: Page, selector: string) {
  const image = page.locator(selector);
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(() => {
  if (!ADMIN_TOKEN) throw new Error('E2E_CLOUD_ADMIN_TOKEN gerekli (bulutun ADMIN_TOKEN degeri).');
});
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

test('POS’suz işletme: panelde menü ve masa, müşteri telefonda görür', async ({ browser }) => {
  const owner = await newTenant('E2E Çorbacı');
  const panel = await phone(browser);
  await panelLogin(panel, owner);
  await expect(panel.getByText('Menü henüz yayınlanmadı.')).toBeVisible();

  await panel.getByRole('button', { name: '+ Kategori' }).click();
  await panel.getByLabel('Ad', { exact: true }).fill('Çorbalar');
  await panel.getByLabel('İngilizce ad (isteğe bağlı)').fill('Soups');
  await panel.getByRole('button', { name: 'Tamam' }).click();
  await panel.getByRole('button', { name: '+ Ürün' }).click();
  await panel.getByTestId('product-name').fill('Mercimek Çorbası');
  await panel.getByTestId('product-price').fill('120,50');
  await panel.getByTestId('product-image-input').setInputFiles({
    name: 'corba.png',
    mimeType: 'image/png',
    buffer: await photo(panel, 1600, 'image/png'),
  });
  await expect(panel.getByTestId('product-image')).toBeVisible();
  await panel.getByTestId('allergen-celery').click();
  await panel.getByTestId('diet-vegan').click();
  await panel.getByLabel('İngilizce ad (isteğe bağlı)').fill('Lentil soup');
  await panel.getByTestId('product-ok').click();
  await panel.getByTestId('save-menu').click();
  await expect(panel.getByText(/Yayında: sürüm 1/)).toBeVisible();

  // Isletme bilgisi menuyle birlikte yayinlanir.
  await panel.getByRole('link', { name: 'İşletme' }).click();
  await panel.getByLabel('Adres').fill('Moda Cad. 12, Kadıköy');
  await panel.getByTestId('business-english').check();
  await panel.getByTestId('save-menu').click();
  await expect(panel.getByTestId('save-status')).toBeHidden();

  await panel.getByRole('link', { name: 'Masalar' }).click();
  await expect(panel.getByTestId('table-name')).toHaveValue('Masa 1');
  await panel.getByLabel('Bölüm (isteğe bağlı)').fill('Bahçe');
  await panel.getByTestId('table-add').click();
  const card = panel.getByTestId('qr-card-Masa 1');
  await expect(card.getByTestId('qr-image')).toBeVisible();
  const href = await card.getByRole('link', { name: 'Önizle' }).getAttribute('href');
  expect(href).toMatch(/^\/m\/[A-Z2-7]{16}$/);

  const customer = await phone(browser);
  await customer.goto(`${CLOUD}${href}`);
  await expect(customer.getByTestId('business-name')).toHaveText('E2E Çorbacı');
  await expect(customer.getByTestId('table-label')).toHaveText('Masa 1 · Bahçe');
  await expect(customer.getByText('₺120,50')).toBeVisible();
  await expect(customer.getByText('Moda Cad. 12, Kadıköy')).toBeVisible();
  await expectImageLoaded(customer, '[data-testid^="menu-item-"] img');
  await customer.getByTestId('lang-en').click();
  await expect(customer.getByText('Lentil soup')).toBeVisible();
  // Sayfa telefonda yatay kaymaz.
  expect(await customer.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    390,
  );
});

test('panel uygulama olarak yüklenir, internetsiz düzenlenir, internet gelince yayınlar', async ({
  browser,
}) => {
  const owner = await newTenant('E2E Çevrimdışı Kafe');
  const panel = await phone(browser);
  const context = panel.context();
  await panelLogin(panel, owner);

  // Yalniz panel uygulama olarak yuklenir: manifest + /panel kapsamli service worker.
  await expect(panel.locator('link[rel="manifest"]')).toHaveAttribute('href', '/panel.webmanifest');
  const scope = await panel.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
  expect(scope).toBe(`${CLOUD}/panel`);
  await panel.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // Internet varken yayinlanan menu cihazda saklanir.
  await panel.getByRole('button', { name: '+ Kategori' }).click();
  await panel.getByLabel('Ad', { exact: true }).fill('Kahveler');
  await panel.getByRole('button', { name: 'Tamam' }).click();
  await panel.getByTestId('save-menu').click();
  await expect(panel.getByText(/Yayında: sürüm 1/)).toBeVisible();

  // Internet kesilir; uygulama yeniden acilir ve cihazdaki son menuyle calisir.
  await context.setOffline(true);
  await panel.reload();
  await expect(panel.getByTestId('offline-banner')).toBeVisible();
  await expect(panel.getByTestId('panel-categories')).toContainText('Kahveler');
  await expect(panel.getByTestId('logout')).toBeDisabled();

  // Internetsiz fotografli urun eklenir ve kaydedilir.
  await panel.getByRole('button', { name: '+ Ürün' }).click();
  await panel.getByTestId('product-name').fill('Filtre Kahve');
  await panel.getByTestId('product-price').fill('85');
  await panel.getByTestId('product-image-input').setInputFiles({
    name: 'kahve.png',
    mimeType: 'image/png',
    buffer: await photo(panel, 1600, 'image/png'),
  });
  await expect(panel.getByTestId('product-image')).toBeVisible();
  await panel.getByTestId('product-ok').click();
  const status = panel.getByTestId('save-status');
  await expect(status).toHaveAttribute('data-state', 'dirty');
  await expect(status).toContainText('İnternet yok');
  // "Kaydederseniz…" ve "Kaydedildi…" metinlerinin ikisinde de "internet gelince" gecer; durum
  // niteligi ayirir. "Kaydedildi" ancak bekleyen yayin cihaza yazildiktan sonra gorunur.
  await panel.getByTestId('save-menu').click();
  await expect(status).toHaveAttribute('data-state', 'queued');
  await expect(status).toContainText('Kaydedildi; internet gelince');

  // Uygulama kapanip acilsa da bekleyen kayit ve fotograf cihazda durur.
  await panel.reload();
  await expect(panel.getByTestId('panel-product-Filtre Kahve')).toBeVisible();
  await expect(status).toHaveAttribute('data-state', 'queued');
  await expect(status).toContainText('Kaydedildi; internet gelince');

  // Internet gelir: kayit kendiliginden yayinlanir.
  await context.setOffline(false);
  await expect(panel.getByTestId('save-status')).toBeHidden({ timeout: 30_000 });
  await expect(panel.getByText(/Yayında: sürüm 2/)).toBeVisible();
  await expect(panel.getByTestId('offline-banner')).toBeHidden();

  // Musteri yeni urunu fotografiyla gorur; musteri sayfasi uygulama degildir.
  await panel.getByRole('link', { name: 'Masalar' }).click();
  await panel.getByTestId('table-add').click();
  const href = await panel
    .getByTestId('qr-card-Masa 1')
    .getByRole('link', { name: 'Önizle' })
    .getAttribute('href');
  const customer = await phone(browser);
  await customer.goto(`${CLOUD}${href}`);
  await expect(customer.getByText('Filtre Kahve')).toBeVisible();
  await expectImageLoaded(customer, '[data-testid^="menu-item-"] img');
  await expect(customer.locator('link[rel="manifest"]')).toHaveCount(0);
  expect(await customer.evaluate(() => navigator.serviceWorker.controller)).toBeNull();

  // Cikis: oturum kapanir, cihazdaki panel verisi silinir.
  await panel.getByTestId('logout').click();
  await expect(panel.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
  const stored = await panel.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('ado-panel');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction(['kv', 'drafts', 'images']);
          const counts = ['kv', 'drafts', 'images'].map((name) => tx.objectStore(name).count());
          tx.oncomplete = () => resolve(counts.reduce((sum, count) => sum + count.result, 0));
        };
      }),
  );
  expect(stored).toBe(0);
});

test.describe('POS’lu işletme', () => {
  const fx = {} as { token: string; product: Named; table: Named };

  test.beforeAll(async () => {
    if (!LICENSE_KEY_FILE) {
      throw new Error('ADO_LICENSE_PRIVATE_KEY_FILE gerekli (scripts/license.mjs gen-key).');
    }
    fx.token = (await pos<{ accessToken: string }>('POST', '/auth/login', OWNER)).accessToken;
    const t = fx.token;
    const tag = Date.now();
    const unit = await pos<Named>('POST', '/units', { name: `Adet${tag}`, abbreviation: 'ad' }, t);
    const tax = await pos<Named>('POST', '/taxes', { name: `KDV${tag}`, ratePermille: 100 }, t);
    const category = await pos<Named>('POST', '/categories', { name: `E2E QR ${tag}` }, t);
    fx.product = await pos<Named>(
      'POST',
      '/products',
      {
        name: `E2E Künefe ${tag}`,
        categoryId: category.id,
        unitId: unit.id,
        taxId: tax.id,
        salePrice: 26000,
        description: 'Hatay peyniri ve Antep fıstığı',
        allergens: ['gluten', 'milk', 'nuts'],
        translations: { en: { name: `E2E Kunefe ${tag}` } },
      },
      t,
    );
    const hall = await pos<Named>('POST', '/halls', { name: `E2E QR Salon ${tag}` }, t);
    fx.table = await pos<Named>('POST', '/tables', { hallId: hall.id, name: 'Masa QR' }, t);
  });

  test.afterAll(async () => {
    // Diger testler bulutsuz POS bekler.
    await pos('DELETE', '/cloud/connection', undefined, fx.token).catch(() => undefined);
  });

  test('lisansla aç, otomatik yayın, tükendi yansır, kapatınca QR menü açmaz', async ({
    page,
    browser,
  }) => {
    // Gorsel POS'a yuklenir; yayinda buluta gider.
    const image = await photo(page, 800, 'image/webp');
    await pos('POST', `/products/${fx.product.id}/image`, image, fx.token);

    // Isletme sahibi saticidan aldigi lisansi Ayarlar > Lisans'a yapistirir.
    await page.goto('/settings');
    await page.getByPlaceholder('ADO1....').fill(e2eLicense('E2E Kebapçı'));
    await page.getByRole('button', { name: 'Lisansı Etkinleştir' }).click();
    await expect(page.getByTestId('license-qr-menu')).toHaveText('QR menü: dahil');

    // QR menu tek tikla acilir: bulut adresi programa gomulu, kod girilmez.
    const cloudCard = page.getByTestId('cloud-card');
    await cloudCard.getByTestId('cloud-activate').click();
    await expect(cloudCard.getByTestId('cloud-last-published')).toContainText('sürüm', {
      timeout: 30_000,
    });
    await expect(cloudCard).toContainText('E2E Kebapçı');
    await expect(cloudCard).toContainText(CLOUD);

    // Musteri masadaki QR'i okutur.
    const table = await pos<{ publicCode: string }>('GET', `/tables/${fx.table.id}`, undefined, fx.token); // prettier-ignore
    const customer = await phone(browser);
    await customer.goto(`${CLOUD}/m/${table.publicCode}`);
    await expect(customer.getByTestId('table-label')).toContainText('Masa QR');
    const item = customer.getByTestId(`menu-item-${fx.product.id}`);
    await expect(item).toContainText(fx.product.name);
    await expect(item).toContainText('₺260,00');
    await expect(item.getByTestId('sold-out')).toHaveCount(0);
    await expectImageLoaded(customer, `[data-testid="menu-item-${fx.product.id}"] img`);

    // POS'ta "tukendi": birkac saniye icinde musteri sayfasinda rozet.
    await pos('PATCH', `/products/${fx.product.id}/availability`, { isAvailable: false }, fx.token);
    await expect
      .poll(
        async () => {
          await customer.reload();
          return item.getByTestId('sold-out').count();
        },
        { timeout: 30_000, intervals: [2000] },
      )
      .toBe(1);

    // QR menu kapatilir: masadaki kod artik menu acmaz (yeniden acinca ayni kodlar calisir).
    page.once('dialog', (dialog) => void dialog.accept());
    await cloudCard.getByTestId('cloud-disconnect').click();
    await expect(cloudCard.getByTestId('cloud-activate')).toBeVisible();
    await customer.reload();
    await expect(customer.getByTestId('menu-error')).toHaveAttribute(
      'data-code',
      'TABLE_NOT_FOUND',
    );
  });
});

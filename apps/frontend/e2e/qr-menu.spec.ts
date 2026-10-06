import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

// QR menu uctan uca: POS (:3001) + bulut (apps/cloud, `wrangler dev`). Bulut adresi
// E2E_CLOUD_URL ile verilir; verilmezse bu dosya calismaz (playwright.config testIgnore).
// CI'da e2e-cloud isi kosar. Satici API anahtari bulutun ADMIN_TOKEN'i ile ayni olmali.
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${ORIGIN}/api/v1`;
const CLOUD = process.env.E2E_CLOUD_URL ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.E2E_CLOUD_ADMIN_TOKEN ?? '';
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
  await expect(panel.getByTestId('save-status')).toContainText('İnternet yok');
  await panel.getByTestId('save-menu').click();
  await expect(panel.getByTestId('save-status')).toContainText('internet gelince');

  // Uygulama kapanip acilsa da bekleyen kayit ve fotograf cihazda durur.
  await panel.reload();
  await expect(panel.getByTestId('panel-product-Filtre Kahve')).toBeVisible();
  await expect(panel.getByTestId('save-status')).toContainText('internet gelince');

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

  test('eşleştir, otomatik yayın, tükendi müşteri sayfasına yansır', async ({ page, browser }) => {
    // Gorsel POS'a yuklenir; yayinda buluta gider.
    const image = await photo(page, 800, 'image/webp');
    await pos('POST', `/products/${fx.product.id}/image`, image, fx.token);

    // Isletme sahibi panelden eslestirme kodu alir.
    const owner = await newTenant('E2E Kebapçı');
    const panel = await phone(browser);
    await panelLogin(panel, owner);
    await panel.getByRole('link', { name: 'Adisyon programı' }).click();
    await panel.getByTestId('pairing-create').click();
    const code = (await panel.getByTestId('pairing-code').textContent()) ?? '';
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await expect(panel.getByTestId('pairing-url')).toHaveText(CLOUD);

    // POS: Ayarlar > QR Menu (Bulut) karti.
    await page.goto('/settings');
    const cloudCard = page.getByTestId('cloud-card');
    await cloudCard.getByPlaceholder('Bulut adresi (ör. menu.ornek.com)').fill(CLOUD);
    await cloudCard.getByPlaceholder('Eşleştirme kodu (ABCD-EFGH)').fill(code);
    await cloudCard.getByRole('button', { name: 'Bağlan' }).click();
    await expect(cloudCard.getByTestId('cloud-last-published')).toContainText('sürüm', {
      timeout: 30_000,
    });
    // Karttan isletme paneline gecilir (yeni sekme; masaustu programda sistem tarayicisi).
    await expect(cloudCard.getByTestId('cloud-panel-link')).toHaveAttribute(
      'href',
      `${CLOUD}/panel`,
    );
    await expect(cloudCard.getByTestId('cloud-panel-link')).toHaveAttribute('target', '_blank');

    // Panel kendiliginden guncellenir; menu artik POS'tan gelir (salt okunur).
    await expect(panel.getByText('Adisyon programı bağlandı.', { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await panel.getByRole('link', { name: 'Menü' }).click();
    await expect(
      panel.getByText('adisyon programından yayınlanıyor', { exact: false }),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: '+ Kategori' })).toHaveCount(0);

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
  });
});

import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildPayload, signLicense } from '../../../scripts/license.mjs';

// QR menu uctan uca: POS (:3001) + bulut (apps/cloud, `wrangler dev`). Bulut adresi
// E2E_CLOUD_URL ile verilir; verilmezse bu dosya calismaz (playwright.config testIgnore).
// CI'da e2e-cloud isi kosar. Lisans girilince POS buluta kendiliginden baglanir (Lisans kartinda
// "Bulut: bagli"); QR menu ayrica acilir. Test lisansi ADO_LICENSE_PRIVATE_KEY_FILE ile imzalanir;
// acik anahtari POS (ADO_LICENSE_PUBLIC_KEY) ve bulut (LICENSE_PUBLIC_KEY) bilir. POS'un gomulu
// bulut adresi (CLOUD_API_URL) E2E_CLOUD_URL ile ayni olmali.
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${ORIGIN}/api/v1`;
const CLOUD = process.env.E2E_CLOUD_URL ?? 'http://127.0.0.1:8787';
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

// Musteri telefonu (390 px); her testin sonunda kapatilir.
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

// Fotograf yerine tarayicida gorsel uretilir: POS'a dogrudan yukleme icin kucultulmus hali
// (800 px WebP; POS arayuzunun gonderdigi bicim).
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

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

test('eski işletme paneli adresi panelin kalktığını söyler', async ({ browser }) => {
  const visitor = await phone(browser);
  await visitor.goto(`${CLOUD}/panel`);
  await expect(visitor.getByTestId('notice-panelGone')).toContainText('İşletme paneli kaldırıldı');
  // Eski panel uygulamasini silen service worker sunulur; her acilista yeniden denetlenir.
  const sw = await visitor.request.get(`${CLOUD}/sw.js`);
  expect(sw.ok()).toBe(true);
  expect(sw.headers()['cache-control']).toBe('no-cache');
  expect(await sw.text()).toContain('registration.unregister()');
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
    // Diger testler yayinsiz POS bekler (bulut baglantisi lisansla kalir).
    await pos('PUT', '/cloud/qr', { enabled: false }, fx.token).catch(() => undefined);
  });

  test('lisansla kendiliğinden bağlan, QR menüyü aç, tükendi yansır, kapatınca QR açmaz', async ({
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

    // Program buluta kendiliginden baglanir (adres programa gomulu, kod girilmez).
    const cloudLink = page.getByTestId('cloud-link');
    await expect(cloudLink).toHaveAttribute('data-mode', 'linked', { timeout: 30_000 });
    await expect(cloudLink).toContainText('Bulut: bağlı');

    // QR menu ayrica, tek tikla acilir.
    const cloudCard = page.getByTestId('cloud-card');
    await cloudCard.getByTestId('qr-enable').click();
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

    // QR menu kapatilir: masadaki kod artik menu acmaz (yeniden acinca ayni kodlar calisir);
    // bulut baglantisi kalir.
    page.once('dialog', (dialog) => void dialog.accept());
    await cloudCard.getByTestId('qr-disable').click();
    await expect(cloudCard.getByTestId('qr-enable')).toBeVisible();
    await expect(cloudLink).toHaveAttribute('data-mode', 'linked');
    await customer.reload();
    await expect(customer.getByTestId('menu-error')).toHaveAttribute(
      'data-code',
      'TABLE_NOT_FOUND',
    );
  });
});

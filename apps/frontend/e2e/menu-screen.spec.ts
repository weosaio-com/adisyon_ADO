import { test, expect, type Page } from '@playwright/test';

// POS urun ekrani, QR menu hazirligi: aciklama, alerjen/diyet, Ingilizce ad, gorsel
// (tarayicida 800 px WebP'ye kucultulur) ve "tukendi" (siparis ekraninda eklenemez).
// Verisini API ile kendisi kurar; diger spec'lerin fixture'larina dokunmaz.
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${ORIGIN}/api/v1`;
const OWNER = {
  username: process.env.SEED_OWNER_USERNAME ?? 'owner',
  password: process.env.SEED_OWNER_PASSWORD ?? 'owner1234',
};

interface Named {
  id: string;
  name: string;
}
interface ProductRow extends Named {
  description: string | null;
  allergens: string[];
  dietTags: string[];
  translations: { en?: { name?: string } };
  imagePath: string | null;
  isAvailable: boolean;
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

const fx = {} as { token: string; category: Named; product: Named; table: Named };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fx.token = (await call<{ accessToken: string }>('POST', '/auth/login', OWNER)).accessToken;
  const t = fx.token;
  const tag = Date.now();
  const unit = await call<Named>('POST', '/units', { name: `Adet${tag}`, abbreviation: 'ad' }, t);
  const tax = await call<Named>('POST', '/taxes', { name: `KDV${tag}`, ratePermille: 100 }, t);
  fx.category = await call<Named>('POST', '/categories', { name: `E2E Çorbalar ${tag}` }, t);
  fx.product = await call<Named>(
    'POST',
    '/products',
    {
      name: `E2E Mercimek ${tag}`,
      categoryId: fx.category.id,
      unitId: unit.id,
      taxId: tax.id,
      salePrice: 12000,
    },
    t,
  );
  const hall = await call<Named>('POST', '/halls', { name: `E2E Menü Salonu ${tag}` }, t);
  fx.table = await call<Named>('POST', '/tables', { hallId: hall.id, name: 'Masa QR' }, t);
});

const product = (id: string) => call<ProductRow>('GET', `/products/${id}`, undefined, fx.token);

// Telefon fotografi yerine tarayicida buyuk bir PNG uretilir (1600x1200).
async function bigPhoto(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1200;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 1600, 1200);
    gradient.addColorStop(0, '#f59e0b');
    gradient.addColorStop(1, '#7c2d12');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1600, 1200);
    return canvas.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function openCategory(page: Page) {
  await page.goto('/menu');
  await page.getByRole('button', { name: fx.category.name, exact: true }).click();
}

test('ürün QR menü bilgileri ve küçültülmüş görselle kaydedilir', async ({ page }) => {
  await openCategory(page);
  await page.getByTestId(`menu-product-${fx.product.id}`).getByRole('button').first().click();
  await expect(page.getByText('Ürün Düzenle')).toBeVisible();

  await page.getByRole('button', { name: 'QR menü bilgileri' }).click();
  // Kayitli urunde gorsel secilince hemen yuklenir.
  await page
    .getByTestId('product-image-input')
    .setInputFiles({ name: 'mercimek.png', mimeType: 'image/png', buffer: await bigPhoto(page) });
  await expect(page.getByTestId('product-image-preview')).toHaveAttribute(
    'src',
    /\/api\/v1\/catalog\/images\/[a-f0-9]{64}\.webp$/,
  );
  await page.getByPlaceholder('İçindekiler, porsiyon…').fill('Günlük taze, limonla');
  await page.getByTestId('chip-gluten').click();
  await page.getByTestId('chip-celery').click();
  await page.getByTestId('chip-vegan').click();
  await page.getByPlaceholder('English name').fill('Lentil soup');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Ürün Düzenle')).toHaveCount(0);

  const saved = await product(fx.product.id);
  expect(saved.description).toBe('Günlük taze, limonla');
  expect(saved.allergens).toEqual(['gluten', 'celery']);
  expect(saved.dietTags).toEqual(['vegan']);
  expect(saved.translations.en?.name).toBe('Lentil soup');
  expect(saved.imagePath).toMatch(/^[a-f0-9]{64}\.webp$/);

  const url = `/api/v1/catalog/images/${saved.imagePath}`;
  const image = await page.evaluate(async (src) => {
    const blob = await (await fetch(src)).blob();
    const bitmap = await createImageBitmap(blob);
    return { type: blob.type, size: blob.size, width: bitmap.width, height: bitmap.height };
  }, url);
  expect(image).toMatchObject({ type: 'image/webp', width: 800, height: 600 });
  expect(image.size).toBeLessThan(200_000);
  await expect(page.getByTestId(`menu-product-${fx.product.id}`).locator('img')).toBeVisible();
});

test('yeni üründe görsel, ürün oluşturulduktan sonra yüklenir', async ({ page }) => {
  const name = `E2E Künefe ${Date.now()}`;
  await openCategory(page);
  await page.getByRole('button', { name: '+ Ürün' }).click();
  await page.getByPlaceholder('Ürün adı').fill(name);
  await page.getByPlaceholder('0.00').fill('180');
  await page.getByRole('button', { name: 'QR menü bilgileri' }).click();
  await page
    .getByTestId('product-image-input')
    .setInputFiles({ name: 'kunefe.png', mimeType: 'image/png', buffer: await bigPhoto(page) });
  // Henuz kimlik yok: onizleme yerel (data:) adresten.
  await expect(page.getByTestId('product-image-preview')).toHaveAttribute(
    'src',
    /^data:image\/webp;base64,/,
  );
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Yeni Ürün')).toHaveCount(0);

  const list = await call<ProductRow[]>(
    'GET',
    `/products?categoryId=${fx.category.id}`,
    undefined,
    fx.token,
  );
  const created = list.filter((p) => p.name === name);
  expect(created).toHaveLength(1);
  expect(created[0]?.imagePath).toMatch(/^[a-f0-9]{64}\.webp$/);
});

test('tükendi işaretlenen ürün siparişe eklenemez', async ({ page }) => {
  await openCategory(page);
  const row = page.getByTestId(`menu-product-${fx.product.id}`);
  await row.getByTestId(`availability-${fx.product.id}`).click();
  await expect(row).toContainText('tükendi');
  await expect.poll(async () => (await product(fx.product.id)).isAvailable).toBe(false);

  await page.goto('/');
  await page.getByTestId(`table-${fx.table.id}`).click();
  await expect(page.getByTestId('order-title')).toHaveText(fx.table.name);
  await page.getByTestId(`category-${fx.category.id}`).click();
  const card = page.getByTestId(`product-${fx.product.id}`);
  await expect(card).toBeDisabled();
  await expect(card).toContainText('Tükendi');
  // Bos kalan adisyonu kapat: diger spec'lerin kasa/masa durumunu etkilemesin.
  await page.getByTestId('discard-order').click();
  await expect(page).toHaveURL(`${ORIGIN}/`);

  await openCategory(page);
  await row.getByTestId(`availability-${fx.product.id}`).click();
  await expect(row).not.toContainText('tükendi');
  await expect.poll(async () => (await product(fx.product.id)).isAvailable).toBe(true);
});

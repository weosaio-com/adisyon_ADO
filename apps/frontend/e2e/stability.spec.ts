import { test, expect, type Page } from '@playwright/test';

// 0.4.1 kararlilik: yerel alert/confirm yerine uygulama ici pencere (Electron'da yerel pencereden
// sonra klavye kilitleniyordu) ve oturum yalniz gercekten bitince giris ekranina yonlendirme
// (gecici sunucu hatasi oturumu silmez; bayat ekran "donmus" gibi kalmaz).
// Verisini API ile kendisi kurar; diger spec'lerin fixture'larina dokunmaz.
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${ORIGIN}/api/v1`;
const OWNER = {
  username: process.env.SEED_OWNER_USERNAME ?? 'owner',
  password: process.env.SEED_OWNER_PASSWORD ?? 'owner1234',
};

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
  permissions: string[];
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

// Yerel pencere (alert/confirm/prompt) acilirsa kaydedilir; testler bos kaldigini dogrular.
function recordNativeDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return seen;
}

test('onay penceresi uygulama içinde: Esc ve arka plan vazgeçer, odak döner, onayla silinir', async ({
  page,
}) => {
  const token = (await call<LoginResult>('POST', '/auth/login', OWNER)).accessToken;
  const tag = Date.now();
  const displayName = `E2E Silinecek ${tag}`;
  let userId = '';
  // PIN aktif kullanicilar arasinda benzersiz olmali (PIN_TAKEN); cakisirsa yeniden dene.
  for (let attempt = 0; !userId; attempt++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    try {
      userId = (
        await call<{ id: string }>(
          'POST',
          '/users',
          { username: `e2e-sil-${tag}`, displayName, role: 'waiter', pin },
          token,
        )
      ).id;
    } catch (err) {
      if (attempt > 3 || !String(err).includes('PIN_TAKEN')) throw err;
    }
  }

  const native = recordNativeDialogs(page);
  await page.goto('/users');
  const row = page.locator('li').filter({ hasText: displayName });
  const remove = row.getByRole('button', { name: 'Sil' });
  const dialog = page.getByRole('dialog', { name: `${displayName} silinsin mi?` });

  // Esc vazgecer; tehlikeli islemde odak "Vazgeç"te baslar, kapaninca dugmeye doner.
  await remove.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Vazgeç' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();

  // Arka plana dokunmak da vazgecer; kullanici silinmez.
  await remove.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  // Pencereden sonra klavye girisi calisir (Electron'daki yerel pencere hatasinin belirtisi).
  const username = page.getByPlaceholder('Kullanıcı adı');
  await username.click();
  await page.keyboard.type('klavye');
  await expect(username).toHaveValue('klavye');

  // Onaylaninca silinir.
  await remove.click();
  await dialog.getByRole('button', { name: 'Sil' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  const users = await call<{ id: string }[]>('GET', '/users', undefined, token);
  expect(users.some((user) => user.id === userId)).toBe(false);
  expect(native).toEqual([]);
});

test('kasa kapalıyken masaya dokununca sayfa içi uyarı ve kasa ekranı düğmesi çıkar', async ({
  page,
}) => {
  const token = (await call<LoginResult>('POST', '/auth/login', OWNER)).accessToken;
  const tag = Date.now();
  const hall = await call<{ id: string }>(
    'POST',
    '/halls',
    { name: `E2E Kasa Salon ${tag}` },
    token,
  );
  const table = await call<{ id: string }>(
    'POST',
    '/tables',
    { hallId: hall.id, name: `E2E Kasa Masa ${tag}` },
    token,
  );
  // Diger testlerin kasa oturumuna dokunmamak icin "kasa kapali" yalniz bu sayfada taklit edilir.
  await page.route('**/api/v1/cash/status', (route) =>
    route.fulfill({ json: { success: true, data: { open: false } } }),
  );
  const native = recordNativeDialogs(page);
  await page.goto('/');
  // Taklit edilen durum yuklendi (pasif serit); sonra bos masaya dokunulur.
  await expect(page.getByText('Kasa oturumu kapalı')).toBeVisible();
  await page.getByTestId(`table-${table.id}`).click();
  const notice = page.getByTestId('tables-notice');
  await expect(notice).toContainText('Yeni adisyon açmak için önce kasa oturumunu açın.');
  await expect(page).toHaveURL(`${ORIGIN}/`);
  await notice.getByRole('button', { name: 'Kasa ekranını aç' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/cash`);
  expect(native).toEqual([]);
});

test('geçici sunucu hatası oturumu silmez; oturum gerçekten bitince giriş ekranına gidilir', async ({
  browser,
}) => {
  const login = await call<LoginResult>('POST', '/auth/login', OWNER);
  const user = { ...login.user, permissions: login.permissions };
  // Suresi dolmus erisim belirteci yerine gecersiz olani: ilk istek 401 alir, yenileme denenir.
  const staleAccess = 'gecersiz-erisim-belirteci';
  const context = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [
        {
          origin: ORIGIN,
          localStorage: [
            { name: 'ado.access', value: staleAccess },
            { name: 'ado.refresh', value: login.refreshToken },
            { name: 'ado.user', value: JSON.stringify(user) },
          ],
        },
      ],
    },
  });
  const page = await context.newPage();
  const stored = (key: string) => page.evaluate((k) => localStorage.getItem(k), key);

  // 1) Veritabani mesgul: /auth/refresh 503 DB_BUSY. Oturum silinmez, giris ekranina gidilmez,
  //    ekran hatayi soyler (eskiden oturum silinip bayat ekran kaliyordu).
  await page.route('**/api/v1/auth/refresh', (route) =>
    route.fulfill({
      status: 503,
      json: { success: false, error: { code: 'DB_BUSY', message: 'Veritabani mesgul.' } },
    }),
  );
  await page.goto('/');
  const loadError = page.getByTestId('tables-load-error');
  await expect(loadError).toContainText('Sistem şu an meşgul, birkaç saniye sonra tekrar deneyin.');
  await expect(page).toHaveURL(`${ORIGIN}/`);
  expect(await stored('ado.access')).toBe(staleAccess);
  expect(await stored('ado.refresh')).toBe(login.refreshToken);

  // 2) Veritabani duzelince ayni oturumla devam edilir: yenileme gecer, masalar yuklenir.
  await page.unroute('**/api/v1/auth/refresh');
  await loadError.getByRole('button', { name: 'Tekrar dene' }).click();
  await expect.poll(() => stored('ado.access')).not.toBe(staleAccess);
  expect(await stored('ado.refresh')).toBe(login.refreshToken);
  await expect(page.getByText('Masalar yükleniyor…')).toBeHidden();
  await expect(loadError).toBeHidden();
  await expect(page).toHaveURL(`${ORIGIN}/`);

  // 3) Oturum sunucuda bitti (yenileme 401): kullanici hangi ekrandaysa giris ekranina gecer.
  await page.evaluate(() => {
    localStorage.setItem('ado.access', 'gecersiz-erisim-belirteci');
    localStorage.setItem('ado.refresh', 'gecersiz-yenileme-belirteci');
  });
  await page.goto('/settings');
  await expect(page).toHaveURL(`${ORIGIN}/login`);
  await expect(page.getByTestId('session-expired')).toHaveText(
    'Oturumunuz sona erdi; lütfen yeniden giriş yapın.',
  );
  expect(await stored('ado.access')).toBeNull();
  expect(await stored('ado.refresh')).toBeNull();
  await context.close();
});

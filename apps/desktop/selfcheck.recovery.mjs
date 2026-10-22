// Kendini toparlama kurallarinin self-check'i (Electron'suz): `node selfcheck.recovery.mjs`
import assert from 'node:assert';
import {
  HEALTH_MAX_FAILURES,
  installFailedDialog,
  livenessProbe,
  allowReload,
  planRestart,
  RELOAD_MAX_IN_WINDOW,
  RELOAD_WINDOW_MS,
  RESTART_DELAYS_MS,
  RESTART_MAX_IN_WINDOW,
  RESTART_STEADY_DELAY_MS,
  RESTART_WINDOW_MS,
  restartGiveUpDialog,
  unresponsiveDialog,
} from './recovery.mjs';

const now = 1_000_000_000;

// --- Ilk denemeler artan beklemeyle, sonra sabit ---
assert.deepStrictEqual(planRestart([], now), { giveUp: false, delayMs: 1_000, recent: [] });
assert.strictEqual(planRestart([now - 1_000], now).delayMs, 5_000);
assert.strictEqual(planRestart([now - 2_000, now - 1_000], now).delayMs, 15_000);
assert.strictEqual(
  planRestart([now - 3_000, now - 2_000, now - 1_000], now).delayMs,
  RESTART_STEADY_DELAY_MS,
);
assert.strictEqual(RESTART_DELAYS_MS.length < RESTART_MAX_IN_WINDOW, true);

// --- Pencerede RESTART_MAX_IN_WINDOW deneme: vazgecilir ---
const many = Array.from({ length: RESTART_MAX_IN_WINDOW }, (_, i) => now - (i + 1) * 60_000);
assert.strictEqual(planRestart(many, now).giveUp, true);

// --- Eski denemeler sayilmaz: uzun sure calisan backend yeniden kisa beklemeyle baslar ---
const old = Array.from({ length: 10 }, (_, i) => now - RESTART_WINDOW_MS - i * 1_000);
const fresh = planRestart(old, now);
assert.deepStrictEqual(fresh, { giveUp: false, delayMs: 1_000, recent: [] });

// --- Pencere yeniden yukleme siniri ---
assert.strictEqual(allowReload([], now).allowed, true);
const reloads = Array.from({ length: RELOAD_MAX_IN_WINDOW }, (_, i) => now - i * 10_000);
assert.strictEqual(allowReload(reloads, now).allowed, false);
assert.strictEqual(
  allowReload(
    reloads.map((at) => at - RELOAD_WINDOW_MS),
    now,
  ).allowed,
  true,
);

// --- Pencere metinleri: kayit dosyasi yolu ve iki secim ---
assert.match(restartGiveUpDialog('C:\\x\\backend-error.log').message, /backend-error\.log/);
assert.deepStrictEqual(unresponsiveDialog().buttons, ['Yeniden yükle', 'Bekle']);

// Guncelleme kurulamadi penceresi: anlasilir Turkce, kayit dosyasinin yolu.
const installFailed = installFailedDialog('C:/kayit.log');
assert.strictEqual(installFailed.title, 'Güncelleme kurulamadı');
assert.match(installFailed.message, /eski sürümle çalışmaya devam/);
assert.match(installFailed.message, /C:\/kayit\.log/);

// --- Askida kalan backend bekcisi (PLT-12) ---
{
  let alive = true;
  let allowed = true;
  const events = [];
  const probe = livenessProbe({
    isAlive: async () => alive,
    canProbe: () => allowed,
    onFailing: (count) => events.push(`failing ${count}`),
    onRecovered: () => events.push('recovered'),
    onHung: async () => events.push('hung'),
  });
  assert.strictEqual(await probe.probe(), 'ok');
  alive = false;
  for (let i = 1; i < HEALTH_MAX_FAILURES; i++) assert.strictEqual(await probe.probe(), 'failing');
  // Kisa takilma (or. 7-8 sn'lik rapor) yeniden baslatmaz: arada yanit gelirse sayac sifirlanir.
  alive = true;
  assert.strictEqual(await probe.probe(), 'recovered');
  alive = false;
  // Kapanis/acilis sirasinda yoklanmaz, sayilmaz.
  allowed = false;
  assert.strictEqual(await probe.probe(), 'skipped');
  allowed = true;
  for (let i = 1; i < HEALTH_MAX_FAILURES; i++) await probe.probe();
  assert.strictEqual(await probe.probe(), 'hung', 'art arda yanitsizlikta askida sayilir');
  assert.strictEqual(events.filter((e) => e === 'hung').length, 1, 'bir kez yeniden baslatilir');
  assert.strictEqual(probe.failures, 0, 'yeniden baslatmadan sonra sayac sifir');
  // Yoklama surerken ikinci yoklama baslamaz (3 sn zaman asimi 15 sn araliktan kisa olsa da).
  let release;
  const slow = livenessProbe({
    isAlive: () => new Promise((resolve) => (release = resolve)),
  });
  const first = slow.probe();
  assert.strictEqual(await slow.probe(), 'skipped');
  release(true);
  assert.strictEqual(await first, 'ok');
  // Yoklama bitince durum degistiyse (kapanis basladi) sonuc sayilmaz.
  let closing = false;
  const late = livenessProbe({
    isAlive: async () => {
      closing = true;
      return false;
    },
    canProbe: () => !closing,
  });
  assert.strictEqual(await late.probe(), 'skipped');
  assert.strictEqual(late.failures, 0);
}

console.log('✓ desktop recovery self-check OK');

// Masaustu acilis kararinin self-check'i (Electron'suz): `node selfcheck.startup.mjs`
// Saglik kontrolu ile backend surecinin kapanmasi yarisir; hata penceresi gercek sebebi soyler.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import {
  BACKEND_START_TIMEOUT_MS,
  outputTail,
  startupFailureDialog,
  waitForBackend,
  watchExit,
} from './startup.mjs';

const never = new Promise(() => {});

// --- Saglik kontrolu birkac denemede gecer ---
{
  let calls = 0;
  const result = await waitForBackend({
    isUp: async () => ++calls >= 3,
    exited: never,
    timeoutMs: 5000,
    intervalMs: 10,
  });
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(calls, 3, 'hazir olunca beklemez');
}

// --- Backend once kapanir: zaman asimi beklenmez, cikis kodu doner ---
{
  const started = Date.now();
  const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
  const result = await waitForBackend({
    isUp: async () => false,
    exited: watchExit(child),
    timeoutMs: 20_000,
    intervalMs: 50,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'exited');
  assert.strictEqual(result.code, 3, 'gercek cikis kodu');
  assert.ok(Date.now() - started < 10_000, 'kapanis hemen farkedilir');
}

// --- Hic hazir olmaz: zaman asimi ---
{
  const result = await waitForBackend({
    isUp: async () => false,
    exited: never,
    timeoutMs: 300,
    intervalMs: 50,
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'timeout' });
}

// --- Asili kalan saglik istegi zaman asimini bozmaz ---
{
  const started = Date.now();
  const result = await waitForBackend({ isUp: () => never, exited: never, timeoutMs: 300 });
  assert.deepStrictEqual(result, { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 3000, 'zaman asimi tutulur');
}

// --- Saglik istegi hata verirse "henuz hazir degil" sayilir ---
{
  let calls = 0;
  const result = await waitForBackend({
    isUp: async () => {
      if (++calls < 2) throw new Error('ECONNREFUSED');
      return true;
    },
    exited: never,
    timeoutMs: 2000,
    intervalMs: 10,
  });
  assert.deepStrictEqual(result, { ok: true });
}

// --- watchExit: baslatilamayan surec ve zaten kapanmis surec ---
{
  const missing = spawn('/olmayan/klasor/program-yok', [], { stdio: 'ignore' });
  const info = await watchExit(missing);
  assert.ok(info.error || info.code !== 0, `baslatma hatasi sonuc verir: ${JSON.stringify(info)}`);

  const done = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => done.once('exit', resolve));
  assert.deepStrictEqual(await watchExit(done), { code: 0, signal: null }, 'kapanmis surec');
}

// --- Hata penceresi: gercek sebep + gunluk yolu; paketli surumde gelistirici ipucu yok ---
{
  const logPath = 'C:\\Users\\ali\\AppData\\Roaming\\@ado\\desktop\\backend-error.log';
  const exited = startupFailureDialog(
    { ok: false, reason: 'exited', code: 1, signal: null },
    {
      logPath,
      packaged: true,
      recentOutput: 'Error: listen EADDRINUSE: address already in use 0.0.0.0:43127',
    },
  );
  assert.strictEqual(exited.title, 'Program başlatılamadı');
  assert.match(exited.message, /çıkış kodu 1/);
  assert.ok(exited.message.includes(logPath), 'gunluk yolu');
  assert.ok(exited.message.includes('EADDRINUSE'), 'son kayitlar');
  assert.ok(!/Dev ise|derlendi mi|build edildi/i.test(exited.message), 'paketli: ipucu yok');

  const timeout = startupFailureDialog(
    { ok: false, reason: 'timeout' },
    { timeoutMs: BACKEND_START_TIMEOUT_MS, logPath, packaged: true },
  );
  assert.match(timeout.message, /60 saniye içinde yanıt vermedi/);
  assert.ok(!timeout.message.includes('Son kayıtlar'), 'cikti yoksa bolum yok');

  const dev = startupFailureDialog(
    { ok: false, reason: 'timeout' },
    { timeoutMs: 30_000, logPath, packaged: false },
  );
  assert.match(dev.message, /apps\/backend\/dist/, 'gelistirmede ipucu var');

  const killed = startupFailureDialog(
    { ok: false, reason: 'exited', code: null, signal: 'SIGKILL' },
    { logPath, packaged: true },
  );
  assert.match(killed.message, /sinyal SIGKILL/);

  const spawnError = startupFailureDialog(
    { ok: false, reason: 'exited', code: null, signal: null, error: 'spawn ENOENT' },
    { logPath, packaged: true },
  );
  assert.match(spawnError.message, /başlatılamadı: spawn ENOENT/);
}

// --- Cikti kuyrugu: son karakterler, satir basindan; renk kodlari temizlenir ---
{
  const tail = outputTail(60);
  tail.push(Buffer.from(`${'a'.repeat(200)}\n`));
  tail.push('\u001b[31mHATA: veritabani kilitli\u001b[39m\n');
  const text = tail.text();
  assert.ok(text.length <= 60, 'boyut sinirli');
  assert.strictEqual(text, 'HATA: veritabani kilitli', 'yarim satir ve renk kodu yok');
  const empty = outputTail();
  assert.strictEqual(empty.text(), '');
  const big = outputTail(100);
  for (let i = 0; i < 1000; i++) big.push(`satir ${i}\n`);
  assert.ok(big.text().endsWith('satir 999'), 'en son kayit korunur');
}

console.log('✓ desktop startup self-check OK');

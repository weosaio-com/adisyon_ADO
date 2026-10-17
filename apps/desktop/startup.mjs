// Backend acilis karari (Electron'suz; selfcheck.startup.mjs ile test edilir): saglik kontrolu
// backend cocuk surecinin kapanmasiyla yarisir. Basarisizlikta pencerede gercek sebep (cikis kodu
// ya da zaman asimi), son kayitlar ve gunluk dosyasinin yolu gosterilir.

/** Backend'in hazir olmasi icin beklenecek en uzun sure (yavas disk/eski bilgisayar payi). */
export const BACKEND_START_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

/** Iptal edilebilir bekleme: sonuc alininca zamanlayici temizlenir, surec bosuna ayakta kalmaz. */
function delay(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Cocuk surecin kapanisini ya da hic baslatilamamasini tek sonuca toplar:
 * `{ code, signal }` ya da `{ code: null, signal: null, error }`. 'error' dinleyicisi, baslatma
 * hatasinin ana sureci dusurmesini de onler.
 */
export function watchExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) =>
      resolve({ code: null, signal: null, error: String(error?.message ?? error) }),
    );
  });
}

/**
 * Backend hazir olana kadar bekler; surec once kapanirsa beklemeyi hemen birakir. Asili kalan
 * saglik istegi zaman asimini bozmaz. Sonuc: `{ ok: true }` | `{ ok: false, reason: 'exited',
 * code, signal, error? }` | `{ ok: false, reason: 'timeout' }`.
 */
export async function waitForBackend({
  isUp,
  exited,
  timeoutMs = BACKEND_START_TIMEOUT_MS,
  intervalMs = POLL_INTERVAL_MS,
}) {
  let exit = null;
  const exitedSignal = exited.then((info) => {
    exit = info;
    return 'exited';
  });
  const exitResult = () => ({ ok: false, reason: 'exited', ...exit });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: 'timeout' };
    const timeout = delay(remaining);
    const outcome = await Promise.race([
      Promise.resolve()
        .then(isUp)
        .then(
          (up) => (up ? 'up' : 'down'),
          () => 'down',
        ),
      exitedSignal,
      timeout.promise.then(() => 'timeout'),
    ]);
    timeout.cancel();
    if (outcome === 'up') return { ok: true };
    if (exit) return exitResult();
    if (outcome === 'timeout') return { ok: false, reason: 'timeout' };
    const pause = delay(Math.min(intervalMs, deadline - Date.now()));
    await Promise.race([pause.promise, exitedSignal]);
    pause.cancel();
    if (exit) return exitResult();
  }
}

// Gelistirme ciktisindaki renk kodlari (pino-pretty) pencerede okunmaz.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Backend ciktisinin son `maxChars` karakteri: hata penceresinde gercek sebep gorunsun. */
export function outputTail(maxChars = 1200) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (buffer.length > maxChars * 4) buffer = buffer.slice(-maxChars * 2);
    },
    text() {
      const clean = buffer.replace(ANSI, '').trim();
      if (clean.length <= maxChars) return clean;
      const tail = clean.slice(-maxChars);
      const lineStart = tail.indexOf('\n');
      return lineStart >= 0 && lineStart < tail.length - 1 ? tail.slice(lineStart + 1) : tail;
    },
  };
}

/** Basarisiz acilis icin hata penceresinin basligi ve metni (Turkce). */
export function startupFailureDialog(
  result,
  { timeoutMs = BACKEND_START_TIMEOUT_MS, logPath, packaged, recentOutput = '' },
) {
  let reason;
  if (result.reason === 'exited') {
    if (result.error) {
      reason = `Arka plandaki sunucu başlatılamadı: ${result.error}`;
    } else if (result.code !== null && result.code !== undefined) {
      reason = `Arka plandaki sunucu açılırken kapandı (çıkış kodu ${result.code}).`;
    } else {
      reason = `Arka plandaki sunucu açılırken kapandı (sinyal ${result.signal ?? 'bilinmiyor'}).`;
    }
  } else {
    reason = `Arka plandaki sunucu ${Math.round(timeoutMs / 1000)} saniye içinde yanıt vermedi.`;
  }
  const lines = [reason];
  const tail = recentOutput.trim();
  if (tail) lines.push('', 'Son kayıtlar:', tail);
  lines.push('', `Ayrıntılı kayıt dosyası: ${logPath}`, '');
  lines.push(
    packaged
      ? 'Bilgisayarı yeniden başlatıp programı tekrar açın. Sorun sürerse bu dosyayı destek ekibine gönderin.'
      : 'Geliştirme: backend derlendi mi? (pnpm --filter @ado/backend build -> apps/backend/dist)',
  );
  return { title: 'Program başlatılamadı', message: lines.join('\n') };
}

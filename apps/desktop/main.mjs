// Electron ince kabuk: backend calismiyorsa cocuk surec olarak baslatir,
// saglik kontrolu gecince pencereyi acar. UI tamamen backend'in sundugu web.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { rotatingLog } from './rotating-log.mjs';
import { applyPendingRestore, ensureSecrets, restoreSkippedDialog } from './restore.mjs';
import { appConfigEnv, loadAppConfig } from './app-config.mjs';
import { applyMigrations } from './migrations.mjs';
import { startBackendProcess, stopBackendProcess } from './backend-process.mjs';
import updaterPackage from 'electron-updater';
import { createUpdater, INSTALL_ERROR_GRACE_MS } from './updater.mjs';
import {
  BACKEND_START_TIMEOUT_MS,
  outputTail,
  startupFailureDialog,
  waitForBackend,
  watchExit,
} from './startup.mjs';
import {
  allowReload,
  installFailedDialog,
  planRestart,
  restartGiveUpDialog,
  UNRESPONSIVE_PROMPT_MS,
  unresponsiveDialog,
} from './recovery.mjs';

// Paketli uygulama dev sunucusuna (3001) yanlislikla baglanmasin.
const PORT = process.env.API_PORT || (app.isPackaged ? '43127' : '3001');
const BASE = `http://127.0.0.1:${PORT}`;
let backend = null;
let backendExit = null;
let writeLog = () => {};
let mainWindow = null;
let appConfig = null;
let updater = null;
let logPath = null;
// Ilk acilis tamamlandi mi: oncesinde backend'in kapanmasini acilis akisi ele alir (hata penceresi).
let backendReady = false;
// Kapanis ya da guncelleme kurulumu: backend'in kapanmasi beklenen, yeniden baslatilmaz.
let shuttingDown = false;
const restartHistory = [];
let restartTimer = null;
const reloadHistory = [];
let unresponsiveTimer = null;
// Acilis basarisiz olursa hata penceresinde gosterilecek son backend ciktisi.
const recentOutput = outputTail();
// Bekleyen yedek geri yuklemesi uygulanamadiysa (bozuk isaret, takas hatasi) pencere acilinca soylenir.
let restoreProblem = null;

// /health yalniz veritabanini denetler (disk dolu olsa da 200). Asili istek beklemeyi uzatmasin.
const isUp = () =>
  fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);

const isLocal = (url) => url === BASE || url.startsWith(`${BASE}/`);
const log = (line) => writeLog(Buffer.from(`[desktop] ${line}\n`));

// Paketli surumde: DB userData'da yasar (kurulum dizini yazilabilir degil),
// gizli anahtarlar ilk aciliste uretilip userData/secrets.json'da saklanir.
// Bekleyen yedek geri yuklemesi (ve tasinan yedek anahtari) backend acilmadan uygulanir.
// Veritabani guncellemesinden once userData/pre-migrate'e kopya alinir (son 3).
// Derleme profili (resources/app-config.json) bulut adresini ve lisans acik anahtarini verir;
// okunamazsa acilis durmaz, yalniz bulut/lisans ozellikleri kapali kalir (hata loga yazilir).
function packagedEnv() {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true }); // ilk aciliste henuz yok
  const dbPath = join(dataDir, 'ado.db');
  const secretsPath = join(dataDir, 'secrets.json');
  applyPendingRestore(dataDir, dbPath, secretsPath, {
    log,
    onProblem: (problem) => {
      const next = problem.setAside
        ? `; isaret kenara alindi: ${problem.setAside}`
        : problem.retry
          ? '; sonraki acilista yeniden denenecek'
          : '';
      log(`geri yukleme uygulanamadi: ${problem.reason}${next}`);
      restoreProblem = problem;
    },
  });
  if (!existsSync(dbPath)) {
    copyFileSync(join(process.resourcesPath, 'template.db'), dbPath);
  }
  const { applied, backup } = applyMigrations(
    dbPath,
    join(process.resourcesPath, 'backend', 'prisma', 'migrations'),
    { backupDir: join(dataDir, 'pre-migrate') },
  );
  if (applied.length) {
    log(`veritabani guncellendi (${applied.join(', ')}); onceki kopya: ${backup ?? 'yok'}`);
  }
  const { config, errors } = loadAppConfig(join(process.resourcesPath, 'app-config.json'));
  for (const error of errors) log(`[app-config] ${error}`);
  appConfig = config;
  return {
    NODE_ENV: 'production',
    // Duz dosya yolu: backend bunu yol olarak da okur (veri dizini). Tek baglanti siniri
    // (connection_limit=1, SQLite tek yazar) backend'in Prisma istemcisinde eklenir (tek kaynak).
    DATABASE_URL: 'file:' + dbPath.replaceAll('\\', '/'),
    ADO_DATA_DIR: dataDir,
    API_PORT: PORT,
    // Garson tabletleri icin yerel HTTPS (cevrimdisi acilis icin sart). Pencere HTTP'de kalir.
    API_TLS_PORT: String(Number(PORT) + 1),
    ADO_APP_VERSION: app.getVersion(),
    ...appConfigEnv(config),
    ...ensureSecrets(secretsPath),
  };
}

function startBackend() {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'backend')
    : join(import.meta.dirname, '..', 'backend');
  // ELECTRON_RUN_AS_NODE: electron.exe'yi duz node olarak kullan (sistemde node gerekmez).
  // IPC kanali: kapanista duzgun durdurma; kabuk cokerse backend kendini kapatir.
  backend = startBackendProcess({
    execPath: process.execPath,
    entry: join(base, 'dist', 'main.js'),
    env: { ...process.env, ...(app.isPackaged ? packagedEnv() : {}), ELECTRON_RUN_AS_NODE: '1' },
    onOutput: (chunk) => {
      writeLog(chunk);
      recentOutput.push(chunk);
    },
  });
  // Acilis beklemesi bununla yarisir: backend coker ya da baslatilamazsa hemen anlasilir.
  backendExit = watchExit(backend);
  const child = backend;
  child.once('exit', (code, signal) => {
    log(`backend kapandi (kod ${code}, sinyal ${signal})`);
    onBackendExit(child);
  });
  child.on('message', onBackendMessage);
}

// Backend beklenmedik kapanirsa (cokme) pencere "Cevrimdisi"da kalmasin: artan beklemeyle yeniden
// baslatilir; arayuz baglanti gelince kendiliginden toparlanir.
function onBackendExit(child) {
  if (child !== backend) return; // yerine yenisi baslatilmis eski surec
  backend = null;
  if (shuttingDown || !backendReady) return;
  scheduleBackendRestart();
}

function scheduleBackendRestart() {
  if (restartTimer || shuttingDown) return;
  const plan = planRestart(restartHistory);
  restartHistory.splice(0, restartHistory.length, ...plan.recent);
  if (plan.giveUp) {
    log('backend kisa surede tekrar tekrar kapandi; yeniden baslatma durduruldu');
    const { title, message } = restartGiveUpDialog(logPath);
    void showMessage({ type: 'error', title, message, buttons: ['Tamam'] });
    return;
  }
  log(
    `backend ${Math.round(plan.delayMs / 1000)} sn sonra yeniden baslatilacak ` +
      `(son 10 dk: ${plan.recent.length} deneme)`,
  );
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartBackend();
  }, plan.delayMs);
}

async function restartBackend() {
  if (shuttingDown) return;
  restartHistory.push(Date.now());
  try {
    startBackend();
  } catch (err) {
    log(`backend yeniden baslatilamadi: ${err && err.stack ? err.stack : err}`);
    scheduleBackendRestart();
    return;
  }
  const child = backend;
  const result = await waitForBackend({
    isUp,
    exited: backendExit,
    timeoutMs: BACKEND_START_TIMEOUT_MS,
  });
  if (result.ok) {
    log('backend yeniden acildi');
    showRestoreProblem();
    // Yeni backend guncelleme durumunu bilmez (Ayarlar > Guncelleme karti): yeniden bildirilir.
    if (updater) sendToBackend({ type: 'update-status', ...updater.status() });
    return;
  }
  log(`backend yeniden acilamadi: ${JSON.stringify(result)}`);
  // Asili kaldiysa kapat: cikis dinleyicisi sonraki denemeyi planlar.
  if (child && child === backend && child.exitCode === null) child.kill();
}

function showRestoreProblem() {
  if (!restoreProblem) return;
  const { title, message } = restoreSkippedDialog(restoreProblem, logPath);
  restoreProblem = null;
  void showMessage({ type: 'warning', title, message, buttons: ['Tamam'] });
}

// Ana surecten acilan pencereden sonra klavye odagi pencereye donsun (Windows'ta kaybolabiliyor).
async function showMessage(options) {
  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = target
    ? await dialog.showMessageBox(target, options)
    : await dialog.showMessageBox(options);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    mainWindow.webContents.focus();
  }
  return result;
}

// Pencere sureci cokerse ya da kilitlenirse sayfa yeniden yuklenir (kisa surede en fazla 3 kez).
function reloadWindow(reason) {
  if (!mainWindow || mainWindow.isDestroyed() || shuttingDown) return;
  const guard = allowReload(reloadHistory);
  reloadHistory.splice(0, reloadHistory.length, ...guard.recent);
  if (!guard.allowed) {
    log(`pencere yeniden yuklenmedi (${reason}): kisa surede cok fazla deneme`);
    return;
  }
  reloadHistory.push(Date.now());
  log(`pencere yeniden yukleniyor (${reason})`);
  mainWindow.loadURL(BASE).catch((err) => log(`pencere yuklenemedi: ${err}`));
}

async function askReloadUnresponsive() {
  if (!mainWindow || mainWindow.isDestroyed() || shuttingDown) return;
  const { title, message, buttons } = unresponsiveDialog();
  const { response } = await showMessage({
    type: 'warning',
    title,
    message,
    buttons,
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) reloadWindow('pencere yanit vermiyordu');
}

const sendToBackend = (message) => {
  if (backend?.connected) backend.send(message);
};

// Backend'den gelen komutlar (Ayarlar > Guncelleme): denetle, onaylanan surumu kur.
function onBackendMessage(message) {
  if (!updater || !message || typeof message !== 'object') return;
  if (message.type === 'update-check') void updater.check();
  if (message.type === 'update-install' && typeof message.version === 'string') {
    void updater.install(message.version, prepareInstall);
  }
}

const UPDATING_PAGE = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Güncelleniyor</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a">
<div style="text-align:center;max-width:420px;padding:24px"><h1 style="font-size:22px">Program güncelleniyor</h1>
<p>Birkaç dakika içinde kendiliğinden yeniden açılacak. Bilgisayarı kapatmayın.</p></div></body></html>`;

// Kurulumdan once: pencerede bilgi sayfasi, backend duzgun kapanir (veritabani kapali olmali).
async function prepareInstall() {
  log('guncelleme kuruluyor');
  shuttingDown = true;
  clearTimeout(restartTimer);
  await mainWindow
    ?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(UPDATING_PAGE)}`)
    .catch(() => {});
  if (backend) {
    log(`backend durduruldu: ${await stopBackendProcess(backend)}`);
    backend = null;
  }
}

// Guncelleme kurulamadi (yukleyici baslamadi ya da program kapanmadi): eskiden pencere "Program
// guncelleniyor"da, backend kapali kaliyordu. Backend yeniden baslar, pencere arayuze doner ve
// kullaniciya soylenir; kasa eski surumle calismayi surdurur (PLT-6).
async function recoverFailedInstall(reason) {
  log(`guncelleme kurulamadi (${reason}); program eski surumle devam ediyor`);
  shuttingDown = false;
  if (!backend) await restartBackend();
  await mainWindow?.loadURL(BASE).catch((err) => log(`pencere yuklenemedi: ${err}`));
  const { title, message } = installFailedDialog(logPath);
  await showMessage({ type: 'error', title, message, buttons: ['Tamam'] });
}

// Paketli surumde guncelleyici: durum backend'e iletilir (kart), denetim kendiliginden.
function startUpdater() {
  if (!app.isPackaged || !appConfig) return;
  updater = createUpdater({
    currentVersion: app.getVersion(),
    config: appConfig,
    log,
    onStatus: (status) => sendToBackend({ type: 'update-status', ...status }),
    autoUpdater: updaterPackage.autoUpdater,
    onInstallFailed: (reason) => void recoverFailedInstall(reason),
  });
  sendToBackend({ type: 'update-status', ...updater.status() });
  updater.start();
}

async function openWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 800 });
  mainWindow.removeMenu();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // Cokme ve kilitlenme: kayda yazilir; cokmede sayfa yeniden yuklenir, 30 sn yanit vermezse sorulur.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`pencere sureci kapandi (${details.reason}, kod ${details.exitCode})`);
    if (details.reason !== 'clean-exit') reloadWindow('pencere sureci kapandi');
  });
  mainWindow.on('unresponsive', () => {
    log('pencere yanit vermiyor');
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      void askReloadUnresponsive();
    }, UNRESPONSIVE_PROMPT_MS);
  });
  mainWindow.on('responsive', () => {
    if (!unresponsiveTimer) return;
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    log('pencere yeniden yanit veriyor');
  });
  // Disari giden baglantilar sistem tarayicisinda acilir; programin icinde menusuz, adres
  // cubugusuz bir pencere olarak kalmaz. Pencerenin kendisi de yerel arayuzden ayrilamaz.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  // Desktop her zaman paketle gelen UI'yi acsin; eski PWA app-shell'i kalmasin.
  await mainWindow.webContents.session.clearStorageData({
    storages: ['serviceworkers', 'cachestorage'],
  });
  await mainWindow.loadURL(BASE);
}

async function start() {
  // Boyut sinirli (10 MB, .1'e doner): surekli acik kasada disk dolmasin.
  logPath = join(app.getPath('userData'), 'backend-error.log');
  writeLog = rotatingLog(logPath);
  try {
    if (app.isPackaged || !(await isUp())) {
      // Dev'de backend'i kendin calistiriyorsan buraya dusmez.
      startBackend();
      const result = await waitForBackend({
        isUp,
        exited: backendExit,
        timeoutMs: BACKEND_START_TIMEOUT_MS,
      });
      if (!result.ok) {
        log(`backend acilamadi: ${JSON.stringify(result)}`);
        // Gercek sebep (cikis kodu / zaman asimi), son kayitlar ve gunluk dosyasinin yolu.
        const { title, message } = startupFailureDialog(result, {
          timeoutMs: BACKEND_START_TIMEOUT_MS,
          logPath,
          packaged: app.isPackaged,
          recentOutput: recentOutput.text(),
        });
        dialog.showErrorBox(title, message);
        app.quit();
        return;
      }
    }
    backendReady = true;
    await openWindow();
    showRestoreProblem();
    startUpdater();
  } catch (err) {
    // Sessiz cikis olmasin: hatayi goster, sonra kapan.
    dialog.showErrorBox('Uygulama başlatılamadı', String(err && err.stack ? err.stack : err));
    app.quit();
  }
}

// Tek kopya: ikinci acilis ayni veritabanina ikinci bir backend baslatmasin; acik pencere one gelir.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
  // GPU ve yardimci surec cokmeleri sessiz kalmasin (beyaz/donuk pencerenin izi).
  app.on('child-process-gone', (_event, details) => {
    log(`alt surec kapandi: ${details.type} (${details.reason}, kod ${details.exitCode})`);
  });
  // Kapanista backend'e duzgun kapanma firsati (en fazla 10 sn): acik istekler biter, veritabani
  // kapanir. Sonra cikis tamamlanir.
  let stopping = false;
  let installQuitDelayed = false;
  app.on('before-quit', (event) => {
    // Guncelleme kurulumu: yukleyici baslatilamazsa electron-updater hatayi birkac sn icinde
    // bildirir. Kapanis o kadar bekletilir; hata gelirse program kapanmaz, geri acilir (PLT-6).
    if (updater?.installing() && !installQuitDelayed) {
      event.preventDefault();
      installQuitDelayed = true;
      setTimeout(() => {
        if (updater.installing()) app.quit();
        else installQuitDelayed = false;
      }, INSTALL_ERROR_GRACE_MS);
      return;
    }
    updater?.quitting();
    updater?.stop();
    shuttingDown = true;
    clearTimeout(restartTimer);
    clearTimeout(unresponsiveTimer);
    if (!backend || stopping) return;
    event.preventDefault();
    stopping = true;
    void stopBackendProcess(backend).then((result) => {
      log(`backend durduruldu: ${result}`);
      backend = null;
      app.quit();
    });
  });
  app.on('quit', () => backend?.kill());
}

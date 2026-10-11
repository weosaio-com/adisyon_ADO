// Electron ince kabuk: backend calismiyorsa cocuk surec olarak baslatir,
// saglik kontrolu gecince pencereyi acar. UI tamamen backend'in sundugu web.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { rotatingLog } from './rotating-log.mjs';
import { applyPendingRestore, ensureSecrets } from './restore.mjs';
import { appConfigEnv, loadAppConfig } from './app-config.mjs';
import { applyMigrations } from './migrations.mjs';
import { startBackendProcess, stopBackendProcess } from './backend-process.mjs';

// Paketli uygulama dev sunucusuna (3001) yanlislikla baglanmasin.
const PORT = process.env.API_PORT || (app.isPackaged ? '43127' : '3001');
const BASE = `http://127.0.0.1:${PORT}`;
let backend = null;
let writeLog = () => {};
let mainWindow = null;

const isUp = () =>
  fetch(`${BASE}/api/v1/health`)
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
  applyPendingRestore(dataDir, dbPath, secretsPath);
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
  return {
    NODE_ENV: 'production',
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
    onOutput: writeLog,
  });
  backend.once('exit', (code, signal) => log(`backend kapandi (kod ${code}, sinyal ${signal})`));
}

async function waitUp(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function openWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 800 });
  mainWindow.removeMenu();
  mainWindow.on('closed', () => {
    mainWindow = null;
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
  writeLog = rotatingLog(join(app.getPath('userData'), 'backend-error.log'));
  try {
    if (app.isPackaged || !(await isUp())) {
      // Dev'de backend'i kendin calistiriyorsan buraya dusmez.
      startBackend();
      if (!(await waitUp(30000))) {
        dialog.showErrorBox(
          'Backend başlatılamadı',
          'Sunucu 30 saniye içinde hazır olmadı. Dev ise: backend build edildi mi? (apps/backend/dist)',
        );
        app.quit();
        return;
      }
    }
    await openWindow();
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
  // Kapanista backend'e duzgun kapanma firsati (en fazla 10 sn): acik istekler biter, veritabani
  // kapanir. Sonra cikis tamamlanir.
  let stopping = false;
  app.on('before-quit', (event) => {
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

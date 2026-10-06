// Electron ince kabuk: backend calismiyorsa cocuk surec olarak baslatir,
// saglik kontrolu gecince pencereyi acar. UI tamamen backend'in sundugu web.
import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { rotatingLog } from './rotating-log.mjs';
import { applyPendingRestore, ensureSecrets } from './restore.mjs';

// Paketli uygulama dev sunucusuna (3001) yanlislikla baglanmasin.
const PORT = process.env.API_PORT || (app.isPackaged ? '43127' : '3001');
const BASE = `http://127.0.0.1:${PORT}`;
let backend = null;

const isUp = () =>
  fetch(`${BASE}/api/v1/health`)
    .then((r) => r.ok)
    .catch(() => false);

// Paketli surumde: DB userData'da yasar (kurulum dizini yazilabilir degil),
// gizli anahtarlar ilk aciliste uretilip userData/secrets.json'da saklanir.
// Bekleyen yedek geri yuklemesi (ve tasinan yedek anahtari) backend acilmadan uygulanir.
function packagedEnv() {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true }); // ilk aciliste henuz yok
  const dbPath = join(dataDir, 'ado.db');
  const secretsPath = join(dataDir, 'secrets.json');
  applyPendingRestore(dataDir, dbPath, secretsPath);
  if (!existsSync(dbPath)) {
    copyFileSync(join(process.resourcesPath, 'template.db'), dbPath);
  }
  applyMigrations(dbPath);
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'file:' + dbPath.replaceAll('\\', '/'),
    ADO_DATA_DIR: dataDir,
    API_PORT: PORT,
    // Garson tabletleri icin yerel HTTPS (cevrimdisi acilis icin sart). Pencere HTTP'de kalir.
    API_TLS_PORT: String(Number(PORT) + 1),
    ...ensureSecrets(secretsPath),
  };
}

function applyMigrations(dbPath) {
  const migrationsDir = join(process.resourcesPath, 'backend', 'prisma', 'migrations');
  if (!existsSync(migrationsDir)) return;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS "_ado_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL)',
    );
    const applied = new Set(
      db
        .prepare('SELECT "name" FROM "_ado_migrations"')
        .all()
        .map((row) => row.name),
    );
    const prismaApplied = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`)
        .get()
        ? db
            .prepare('SELECT "migration_name" FROM "_prisma_migrations"')
            .all()
            .map((row) => row.migration_name)
        : [],
    );
    for (const name of readdirSync(migrationsDir).sort()) {
      const sqlPath = join(migrationsDir, name, 'migration.sql');
      if (!existsSync(sqlPath) || applied.has(name)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!prismaApplied.has(name)) db.exec(readFileSync(sqlPath, 'utf8'));
        db.prepare('INSERT INTO "_ado_migrations" ("name", "applied_at") VALUES (?, ?)').run(
          name,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    db.close();
  }
}

function startBackend() {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'backend')
    : join(import.meta.dirname, '..', 'backend');

  // Boyut sinirli (10 MB, .1'e doner): surekli acik kasada disk dolmasin.
  const writeLog = rotatingLog(join(app.getPath('userData'), 'backend-error.log'));

  // ELECTRON_RUN_AS_NODE: electron.exe'yi duz node olarak kullan (sistemde node gerekmez).
  backend = spawn(process.execPath, [join(base, 'dist', 'main.js')], {
    env: {
      ...process.env,
      ...(app.isPackaged ? packagedEnv() : {}),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backend.stdout.on('data', writeLog);
  backend.stderr.on('data', writeLog);
}

async function waitUp(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

app.whenReady().then(async () => {
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
    const win = new BrowserWindow({ width: 1280, height: 800 });
    win.removeMenu();
    // Desktop her zaman paketle gelen UI'yi acsin; eski PWA app-shell'i kalmasin.
    await win.webContents.session.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });
    await win.loadURL(BASE);
  } catch (err) {
    // Sessiz cikis olmasin: hatayi goster, sonra kapan.
    dialog.showErrorBox('Uygulama başlatılamadı', String(err && err.stack ? err.stack : err));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => backend?.kill());

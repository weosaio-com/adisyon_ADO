// userData yardimcilari (Electron'suz; selfcheck.mjs ile test edilir):
// gizli anahtarlar (secrets.json) + bekleyen yedek geri yuklemesi (restore-pending.json).
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_SECRETS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'BACKUP_ENCRYPTION_KEY'];

function readSecrets(secretsPath) {
  return existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, 'utf8')) : {};
}

// tmp + rename: yarim yazilmis secrets.json ile acilis olmasin.
function writeSecrets(secretsPath, secrets) {
  const tmp = `${secretsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(secrets));
  renameSync(tmp, secretsPath);
}

/** Eksik gizli anahtarlari uretir (ilk acilis), mevcutlara dokunmaz; tumunu dondurur. */
export function ensureSecrets(secretsPath) {
  const secrets = readSecrets(secretsPath);
  let changed = false;
  for (const name of REQUIRED_SECRETS) {
    if (typeof secrets[name] !== 'string' || !secrets[name]) {
      secrets[name] = randomBytes(32).toString('hex');
      changed = true;
    }
  }
  if (changed) writeSecrets(secretsPath, secrets);
  return secrets;
}

/** SQLite'in veritabani dosyasina adiyla bagli yan dosyalari (sicak gunluk, WAL). */
const SIDECARS = ['-journal', '-wal', '-shm'];
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Isareti okur ve dogrular: `{ stagePath, backupKey }` ya da `{ error }` (gecersiz isaret). */
function readMarker(dataDir, markerPath) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (error) {
    return { error: `geri yukleme kaydi okunamadi (${error.message})` };
  }
  const stagePath = marker && typeof marker.stagePath === 'string' ? resolve(marker.stagePath) : '';
  const stageRelative = relative(resolve(dataDir), stagePath);
  if (!stagePath || stageRelative.startsWith('..') || isAbsolute(stageRelative)) {
    return { error: 'Gecersiz restore staging kaydi (veri dizini disi ya da bos yol).' };
  }
  if (!existsSync(stagePath)) return { error: `geri yuklenecek dosya bulunamadi: ${stagePath}` };
  const backupKey = typeof marker.backupKey === 'string' ? marker.backupKey.trim() : '';
  return { stagePath, backupKey };
}

/**
 * Canli DB yarim kalmis bir yazmanin "sicak gunlugunu" tasiyorsa (elektrik kesintisi, zorla
 * kapatma) once onu uygular: SQLite DB'yi ilk okumada gunlukten geri alir ve gunlugu siler.
 * Gunluk adla eslesir; takastan sonra geride kalsaydi yeni (geri yuklenen) DB'ye uygulanir, veri
 * sessizce eski hale donerdi (PLT-2). Acilamazsa (bozuk DB) yan dosyalar DB ile birlikte tasinir.
 */
function settleJournal(dbPath, log) {
  if (!SIDECARS.some((suffix) => existsSync(dbPath + suffix))) return;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
    } finally {
      db.close();
    }
    log(`geri yukleme: eski veritabaninin yarim kalan islemi geri alindi`);
  } catch (error) {
    log(
      `geri yukleme: eski veritabani gunlugu uygulanamadi (${error.message}); birlikte tasinacak`,
    );
  }
}

/** Isareti `restore-pending.invalid-<zaman>.json` olarak kenara alir (silinemezse siler). */
function setAside(markerPath) {
  const base = markerPath.replace(/\.json$/, `.invalid-${stamp()}`);
  let aside = `${base}.json`;
  for (let i = 2; existsSync(aside); i++) aside = `${base}-${i}.json`; // ayni ms'de ikinci kayit
  try {
    renameSync(markerPath, aside);
    return aside;
  } catch {
    rmSync(markerPath, { force: true });
    return null;
  }
}

/**
 * restore-pending.json varsa staging DB'yi canli DB ile takas eder (backend calismiyorken,
 * acilista). Isarette `backupKey` varsa yedek baska bir kurulumun anahtariyla acilmistir:
 * BACKUP_ENCRYPTION_KEY takasla birlikte o anahtara cevrilir, boylece sahibinin sakladigi kurtarma
 * anahtari bu bilgisayarda da gecerli kalir. Takas yapildiysa true.
 *
 * Program hicbir durumda bu yuzden acilmaz hale gelmez (PLT-3): gecersiz isaret (yarim yazilmis,
 * veri dizini disi, staging dosyasi yok) takas yapilmadan kenara alinir; takas sirasindaki hata
 * (disk dolu, dosya kilitli) geri alinir ve isaret bir sonraki acilis icin kalir. Ikisinde de
 * `onProblem({ reason, setAside, retry })` cagrilir (kayit + kullaniciya bilgi), DB eski haliyle acilir.
 */
export function applyPendingRestore(
  dataDir,
  dbPath,
  secretsPath,
  { onProblem = () => {}, log = () => {} } = {},
) {
  const markerPath = join(dataDir, 'restore-pending.json');
  if (!existsSync(markerPath)) return false;
  const marker = readMarker(dataDir, markerPath);
  if (marker.error) {
    onProblem({ reason: marker.error, setAside: setAside(markerPath), retry: false });
    return false;
  }
  const incoming = join(dataDir, 'ado.restore-incoming.db');
  const rollback = join(dataDir, `ado.pre-restore-${Date.now()}.db`);
  const previousSecrets = existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : null;
  const moved = []; // [from, to]: hata olursa ters sirayla geri alinir
  const move = (from, to) => {
    renameSync(from, to);
    moved.push([from, to]);
  };
  try {
    if (marker.backupKey.length >= 16) {
      writeSecrets(secretsPath, {
        ...readSecrets(secretsPath),
        BACKUP_ENCRYPTION_KEY: marker.backupKey,
      });
    }
    copyFileSync(marker.stagePath, incoming);
    if (existsSync(dbPath)) {
      settleJournal(dbPath, log);
      move(dbPath, rollback);
      // Kalan yan dosyalar eski DB'ye aittir: geri donus kopyasiyla birlikte gider.
      for (const suffix of SIDECARS) {
        if (existsSync(dbPath + suffix)) move(dbPath + suffix, rollback + suffix);
      }
    }
    move(incoming, dbPath);
  } catch (error) {
    for (const [from, to] of moved.reverse()) {
      try {
        renameSync(to, from);
      } catch {
        // Geri alinamayan dosya yerinde kalir; kayitta gorunur.
      }
    }
    // Temizlik en iyi cabayla: geri alma asla acilisi dusurmez.
    try {
      rmSync(incoming, { force: true });
    } catch {
      // Yarim kopya kalirsa sonraki takas onu ezer.
    }
    try {
      if (previousSecrets === null) rmSync(secretsPath, { force: true });
      else writeFileSync(secretsPath, previousSecrets);
    } catch {
      // Anahtar dosyasi yazilamadiysa eskisi zaten yerindedir.
    }
    onProblem({ reason: `takas yapilamadi (${error.message})`, setAside: null, retry: true });
    return false;
  }
  // Takas tamam: isaret once tuketilir (kesinti olursa ayni yedek ikinci kez uygulanmasin).
  try {
    unlinkSync(markerPath);
  } catch {
    setAside(markerPath);
  }
  rmSync(marker.stagePath, { force: true });
  return true;
}

/** Bekleyen geri yukleme uygulanamayinca (program mevcut verilerle acildi) gosterilecek pencere. */
export function restoreSkippedDialog({ retry }, logPath) {
  return {
    title: 'Yedek geri yüklenemedi',
    message:
      (retry
        ? 'Bekleyen yedek geri yüklemesi bu açılışta uygulanamadı; programın bir sonraki ' +
          'açılışında yeniden denenecek.'
        : 'Bekleyen yedek geri yüklemesi uygulanamadı: geri yükleme kaydı bozuk ya da yedek ' +
          'dosyası bulunamadı. Geri yüklemeyi Ayarlar ekranındaki yedekler bölümünden yeniden ' +
          'başlatabilirsiniz.') +
      '\n\nProgram mevcut verilerle açıldı; hiçbir veri silinmedi. Sorun sürerse şu kayıt ' +
      `dosyasını destek ekibine gönderin:\n${logPath ?? '(bilinmiyor)'}`,
  };
}

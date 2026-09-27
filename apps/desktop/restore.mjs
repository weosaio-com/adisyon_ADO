// userData yardimcilari (Electron'suz; selfcheck.mjs ile test edilir):
// gizli anahtarlar (secrets.json) + bekleyen yedek geri yuklemesi (restore-pending.json).
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

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

/**
 * restore-pending.json varsa staging DB'yi canli DB ile takas eder (backend
 * calismiyorken, acilista). Isarette `backupKey` varsa yedek baska bir kurulumun
 * anahtariyla acilmistir: BACKUP_ENCRYPTION_KEY takastan ONCE o anahtara cevrilir,
 * boylece sahibinin sakladigi kurtarma anahtari bu bilgisayarda da gecerli kalir
 * (yazma hatasi takasi hic baslatmadan iptal eder). Takas yapildiysa true.
 */
export function applyPendingRestore(dataDir, dbPath, secretsPath) {
  const markerPath = join(dataDir, 'restore-pending.json');
  if (!existsSync(markerPath)) return false;
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  const stagePath = typeof marker.stagePath === 'string' ? resolve(marker.stagePath) : '';
  const stageRelative = relative(resolve(dataDir), stagePath);
  if (
    !stagePath ||
    stageRelative.startsWith('..') ||
    isAbsolute(stageRelative) ||
    !existsSync(stagePath)
  ) {
    throw new Error('Gecersiz restore staging kaydi.');
  }
  const backupKey = typeof marker.backupKey === 'string' ? marker.backupKey.trim() : '';
  if (backupKey.length >= 16) {
    writeSecrets(secretsPath, { ...readSecrets(secretsPath), BACKUP_ENCRYPTION_KEY: backupKey });
  }
  const incoming = join(dataDir, 'ado.restore-incoming.db');
  const rollback = join(dataDir, `ado.pre-restore-${Date.now()}.db`);
  copyFileSync(stagePath, incoming);
  if (existsSync(dbPath)) renameSync(dbPath, rollback);
  try {
    renameSync(incoming, dbPath);
    unlinkSync(stagePath);
    unlinkSync(markerPath);
  } catch (error) {
    if (!existsSync(dbPath) && existsSync(rollback)) renameSync(rollback, dbPath);
    throw error;
  }
  return true;
}

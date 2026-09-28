import assert from 'node:assert';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Sifreli yedek dosyasi bicimi (degismedi): IV(12) + AuthTag(16) + AES-256-GCM veri.
// AES anahtari = sha256(ham anahtar metni). Ham anahtar paketli surumde ilk
// acilista uretilir (userData/secrets.json -> BACKUP_ENCRYPTION_KEY, 64 hex).
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const BACKUP_HEADER_BYTES = IV_BYTES + TAG_BYTES;

const aesKey = (rawKey: string): Buffer => createHash('sha256').update(rawKey).digest();

export function encryptBackup(plain: Buffer, rawKey: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, aesKey(rawKey), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

/** Cozer; anahtar yanlis ya da dosya bozuksa null (GCM etiketi dogrular). */
export function decryptBackup(blob: Buffer, rawKey: string): Buffer | null {
  if (blob.length < BACKUP_HEADER_BYTES) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, aesKey(rawKey), blob.subarray(0, IV_BYTES));
    decipher.setAuthTag(blob.subarray(IV_BYTES, BACKUP_HEADER_BYTES));
    return Buffer.concat([decipher.update(blob.subarray(BACKUP_HEADER_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/i;

/** Sahibine gosterilen bicim: 64 hex anahtar 4'lu gruplar halinde (yazmasi kolay). */
export function formatRecoveryKey(rawKey: string): string {
  const key = rawKey.trim();
  return HEX_KEY.test(key) ? key.toLowerCase().match(/.{4}/g)!.join('-') : key;
}

/**
 * Girilen kurtarma anahtari icin denenecek ham anahtarlar: aynen, bosluk/tire
 * temizlenmis ve bunun kucuk harflisi. Yanlis aday GCM'de reddedilir (guvenli).
 */
export function recoveryKeyCandidates(input: string): string[] {
  const exact = input.trim();
  const compact = exact.replace(/[\s-]/g, '');
  return [...new Set([exact, compact.toLowerCase(), compact])].filter((k) => k.length >= 16);
}

// --- self-check: `ts-node src/backup/backup.keys.ts` ---
if (require.main === module) {
  const raw = randomBytes(32).toString('hex');
  const plain = Buffer.from('SQLite format 3\u0000 ... cay, simit, sis kofte');
  const blob = encryptBackup(plain, raw);

  assert.deepStrictEqual(decryptBackup(blob, raw), plain, 'dogru anahtar cozer');
  assert.strictEqual(decryptBackup(blob, randomBytes(32).toString('hex')), null, 'yanlis anahtar');
  const tampered = Buffer.from(blob);
  const last = tampered.length - 1;
  tampered[last] = tampered.readUInt8(last) ^ 0xff;
  assert.strictEqual(decryptBackup(tampered, raw), null, 'bozulmus dosya reddedilir');
  assert.strictEqual(decryptBackup(blob.subarray(0, 10), raw), null, 'kisa dosya reddedilir');

  // Gosterilen bicim -> adaylardan biri ham anahtardir (buyuk harf/bosluk da tolere edilir).
  const shown = formatRecoveryKey(raw);
  assert.match(shown, /^([0-9a-f]{4}-){15}[0-9a-f]{4}$/, `bicim: ${shown}`);
  for (const typed of [shown, shown.toUpperCase(), ` ${shown.replace(/-/g, ' ')} `]) {
    const hit = recoveryKeyCandidates(typed).find((k) => decryptBackup(blob, k));
    assert.strictEqual(hit, raw, `girilen bicim cozmeli: ${typed}`);
  }

  // Hex olmayan (gelistirme) anahtari aynen gosterilir ve aynen calisir.
  const devKey = 'ci-test-backup-key-0123456789abcdef';
  assert.strictEqual(formatRecoveryKey(devKey), devKey, 'hex olmayan anahtar aynen');
  const devBlob = encryptBackup(plain, devKey);
  assert.ok(
    recoveryKeyCandidates(devKey).some((k) => decryptBackup(devBlob, k)),
    'dev anahtari aynen',
  );
  assert.deepStrictEqual(recoveryKeyCandidates('kisa'), [], 'cok kisa girdi aday uretmez');

  console.log('✓ backup.keys self-check OK');
}

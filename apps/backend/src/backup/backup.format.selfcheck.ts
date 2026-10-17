// Yedek bicimi v2 self-check'i: `ts-node --transpile-only src/backup/backup.format.selfcheck.ts`
// Akisla sifreleme/cozme, checksum = dosyanin sha256'si, kurcalanmis/kesik dosya, eski bicim (v1).
import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackup, formatRecoveryKey, recoveryKeyCandidates } from './backup.keys';
import {
  BACKUP_MAGIC,
  BackupFormatError,
  decryptBackupFile,
  decryptFileV2,
  detectFileFormat,
  encryptFileV2,
  FLAG_GZIP,
  inspectBackupFile,
  sha256File,
  TAG_BYTES,
  V2_HEADER_BYTES,
} from './backup.format';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'ado-backup-format-'));
  const file = (name: string) => join(dir, name);
  try {
    const key = randomBytes(32).toString('hex');
    // Bir akis parcasindan (1 MiB) buyuk; rastgele (sikismaz) ve tekrarli (sikisir) kisimlar.
    const plain = Buffer.concat([
      Buffer.from('SQLite format 3\u0000'),
      randomBytes(1_500_000),
      Buffer.alloc(2_000_000, 0x61),
      randomBytes(300_000),
    ]);
    writeFileSync(file('plain.db'), plain);

    // --- Sifreleme: baslik, boyut, checksum ---
    const { sha256, sizeBytes } = await encryptFileV2(file('plain.db'), file('v2.enc'), key);
    const blob = readFileSync(file('v2.enc'));
    assert.strictEqual(sizeBytes, blob.length, 'donen boyut diskteki dosya');
    assert.strictEqual(
      sha256,
      createHash('sha256').update(blob).digest('hex'),
      'checksum = dosyanin tamaminin sha256si',
    );
    assert.strictEqual(await sha256File(file('v2.enc')), sha256, 'akisla ozet ayni');
    assert.ok(blob.subarray(0, 8).equals(BACKUP_MAGIC), 'MAGIC basta');
    assert.strictEqual(blob.readUInt8(8), 2, 'surum 2');
    assert.strictEqual(blob.readUInt8(9) & FLAG_GZIP, FLAG_GZIP, 'gzip bayragi');
    assert.ok(sizeBytes < plain.length, 'sikistirma isliyor');
    assert.deepStrictEqual(await inspectBackupFile(file('v2.enc')), { format: 2, sizeBytes });

    // --- Gidis-donus ---
    assert.strictEqual(await decryptBackupFile(file('v2.enc'), file('out.db'), key), true);
    assert.ok(readFileSync(file('out.db')).equals(plain), 'cozulen = orijinal');

    // --- Yanlis anahtar: false, hedef dosya kalmaz ---
    const wrong = randomBytes(32).toString('hex');
    assert.strictEqual(await decryptBackupFile(file('v2.enc'), file('wrong.db'), wrong), false);
    assert.ok(!existsSync(file('wrong.db')), 'yanlis anahtarda staging silinir');

    // --- Kurtarma anahtari (gosterilen bicim, buyuk harf) v2'yi de acar ---
    let opened = false;
    for (const candidate of recoveryKeyCandidates(formatRecoveryKey(key).toUpperCase())) {
      if (await decryptBackupFile(file('v2.enc'), file('rk.db'), candidate)) {
        opened = true;
        break;
      }
    }
    assert.ok(opened && readFileSync(file('rk.db')).equals(plain), 'kurtarma anahtari v2 acar');

    // --- Kurcalanmis baslik / govde / etiket reddedilir ---
    // Reddetme: false (acilamadi) ya da BackupFormatError (MAGIC bozuldu -> desteklenmeyen bicim).
    const tamperAt = async (offset: number, label: string) => {
      const copy = Buffer.from(blob);
      copy.writeUInt8(copy.readUInt8(offset) ^ 0x01, offset);
      writeFileSync(file('tampered.enc'), copy);
      const result = await decryptBackupFile(file('tampered.enc'), file('tampered.db'), key).catch(
        (err: unknown) => (err instanceof BackupFormatError ? 'format' : err),
      );
      assert.ok(result === false || result === 'format', `kurcalanmis ${label} reddedilir`);
      assert.ok(!existsSync(file('tampered.db')), `kurcalanmis ${label}: staging silinir`);
    };
    await tamperAt(0, 'MAGIC basi'); // onek tutmaz -> v1 sanilir, v1 cozumu de tutmaz
    await tamperAt(7, 'MAGIC sonu'); // onek tutar, MAGIC tutmaz -> desteklenmeyen bicim
    await tamperAt(8, 'surum');
    await tamperAt(9, 'bayrak (gzip kapali sanilir; AAD tutmaz)');
    await tamperAt(V2_HEADER_BYTES - 1, 'IV');
    await tamperAt(V2_HEADER_BYTES + 10, 'govde basi');
    await tamperAt(Math.floor(blob.length / 2), 'govde ortasi');
    await tamperAt(blob.length - TAG_BYTES - 1, 'govde sonu');
    await tamperAt(blob.length - 1, 'etiket');

    // --- Kesik dosya reddedilir ---
    for (const cut of [1, TAG_BYTES, 4096, Math.floor(blob.length / 2)]) {
      writeFileSync(file('cut.enc'), blob.subarray(0, blob.length - cut));
      assert.strictEqual(
        await decryptFileV2(file('cut.enc'), file('cut.db'), key),
        false,
        `kesik dosya (-${cut}) reddedilir`,
      );
      assert.ok(!existsSync(file('cut.db')), 'kesik dosyada staging silinir');
    }
    writeFileSync(file('tiny.enc'), blob.subarray(0, V2_HEADER_BYTES + TAG_BYTES));
    await assert.rejects(inspectBackupFile(file('tiny.enc')), (err: unknown) => {
      return err instanceof BackupFormatError && err.code === 'BACKUP_INVALID';
    });
    assert.strictEqual(await decryptFileV2(file('tiny.enc'), file('tiny.db'), key), false);

    // --- Daha yeni surum: v1 sanilmaz, "desteklenmiyor" ---
    const future = Buffer.from(blob);
    future.write('ADOBAK3', 0, 'latin1');
    writeFileSync(file('future.enc'), future);
    await assert.rejects(inspectBackupFile(file('future.enc')), (err: unknown) => {
      return err instanceof BackupFormatError && err.code === 'BACKUP_UNSUPPORTED';
    });
    const unknownFlags = Buffer.from(blob);
    unknownFlags.writeUInt8(0x80 | FLAG_GZIP, 9);
    writeFileSync(file('flags.enc'), unknownFlags);
    await assert.rejects(detectFileFormat(file('flags.enc')), BackupFormatError);

    // --- Eski bicim (v1) hala acilir ---
    writeFileSync(file('v1.enc'), encryptBackup(plain, key));
    assert.strictEqual(await detectFileFormat(file('v1.enc')), 1, 'v1 algilanir');
    assert.deepStrictEqual(await inspectBackupFile(file('v1.enc')), {
      format: 1,
      sizeBytes: readFileSync(file('v1.enc')).length,
    });
    assert.strictEqual(await decryptBackupFile(file('v1.enc'), file('v1.db'), key), true);
    assert.ok(readFileSync(file('v1.db')).equals(plain), 'v1 cozulur');
    assert.strictEqual(await decryptBackupFile(file('v1.enc'), file('v1w.db'), wrong), false);
    assert.ok(!existsSync(file('v1w.db')), 'v1 yanlis anahtar: dosya yazilmaz');
    writeFileSync(file('v1tiny.enc'), Buffer.alloc(28));
    await assert.rejects(inspectBackupFile(file('v1tiny.enc')), BackupFormatError);

    // --- Gelistirme anahtari (hex degil) da calisir; bos dosya da gidis-donus yapar ---
    const devKey = 'ci-test-backup-key-0123456789abcdef';
    writeFileSync(file('empty.db'), Buffer.alloc(0));
    await encryptFileV2(file('empty.db'), file('empty.enc'), devKey);
    assert.strictEqual(await decryptBackupFile(file('empty.enc'), file('empty.out'), devKey), true);
    assert.strictEqual(readFileSync(file('empty.out')).length, 0, 'bos dosya');

    // --- Kaynak yoksa sifreleme hata verir ve yarim hedef birakmaz ---
    await assert.rejects(encryptFileV2(file('yok.db'), file('yok.enc'), key));
    assert.ok(!existsSync(file('yok.enc')), 'yarim hedef silinir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('✓ backup.format self-check OK');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

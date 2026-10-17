// Gunluk bakim kurallarinin self-check'i (sabit tarihler):
// `ts-node --transpile-only src/maintenance/maintenance.rules.selfcheck.ts`
import assert from 'node:assert';
import {
  FINISHED_JOB_STATUSES,
  isLogFile,
  isOrphanImage,
  isPreRestoreCopy,
  isStaleBackupLeftover,
  preRestoreToDelete,
  PRINTED_JOB_STATUS,
  PURGE_DAYS,
  purgeCutoffs,
} from './maintenance.rules';

const DAY = 86_400_000;
const now = new Date('2026-10-14T05:30:00.000Z');
const ago = (days: number) => now.getTime() - days * DAY;

// --- Sinirlar ---
const cut = purgeCutoffs(now);
assert.strictEqual(cut.backgroundJobs.toISOString(), '2026-09-14T05:30:00.000Z', 'isler 30 gun');
assert.strictEqual(cut.printJobs.toISOString(), '2026-07-16T05:30:00.000Z', 'fis isleri 90 gun');
assert.strictEqual(cut.clientOps.toISOString(), '2026-09-14T05:30:00.000Z', 'islem defteri 30 gun');
assert.strictEqual(cut.sessions.toISOString(), '2026-09-14T05:30:00.000Z', 'oturumlar 30 gun');
assert.strictEqual(cut.orphanImages.toISOString(), '2026-10-07T05:30:00.000Z', 'gorseller 7 gun');
assert.strictEqual(cut.tempFiles.toISOString(), '2026-10-13T05:30:00.000Z', 'gecici dosya 1 gun');
assert.deepStrictEqual(Object.keys(cut).sort(), Object.keys(PURGE_DAYS).sort());

// Gercek durum degerleri (worker.service.ts / @ado/shared PrintJobStatus).
assert.deepStrictEqual([...FINISHED_JOB_STATUSES], ['completed', 'failed']);
assert.strictEqual(PRINTED_JOB_STATUS, 'done');

// --- Sahipsiz gorsel ---
const key = 'a'.repeat(64) + '.webp';
const other = 'b'.repeat(64) + '.jpg';
const referenced = new Set([key]);
assert.ok(isOrphanImage(other, referenced, ago(8), cut.orphanImages), 'urunsuz + 8 gunluk');
assert.ok(
  !isOrphanImage(other, referenced, ago(6), cut.orphanImages),
  '6 gunluk: urune baglanmamis olabilir',
);
assert.ok(!isOrphanImage(key, referenced, ago(100), cut.orphanImages), 'urun gosteriyor');
assert.ok(
  isOrphanImage(`${other}.0a1b2c3d4e5f.tmp`, referenced, ago(8), cut.orphanImages),
  'yarim .tmp',
);
assert.ok(
  !isOrphanImage('logo.png', referenced, ago(100), cut.orphanImages),
  'baska ad: dokunulmaz',
);
assert.ok(
  !isOrphanImage('A'.repeat(64) + '.webp', referenced, ago(100), cut.orphanImages),
  'buyuk harf anahtar degil',
);
assert.ok(
  !isOrphanImage(`${other}.gif`, referenced, ago(100), cut.orphanImages),
  'desteklenmeyen uzanti',
);

// --- Yedek klasorundeki artik dosyalar ---
assert.ok(
  isStaleBackupLeftover('temp_01ABC.db', ago(2), cut.tempFiles, false),
  'eski gecici kopya',
);
assert.ok(
  isStaleBackupLeftover('temp_01ABC.db.enc', ago(2), cut.tempFiles, false),
  'eski gecici sifreli',
);
assert.ok(
  !isStaleBackupLeftover('temp_01ABC.db', ago(0.5), cut.tempFiles, false),
  'yeni: suren yedek olabilir',
);
assert.ok(
  isStaleBackupLeftover('restore_staging_01ABC.db', ago(3), cut.tempFiles, false),
  'kullanilmayan staging',
);
assert.ok(
  !isStaleBackupLeftover('restore_staging_01ABC.db', ago(3), cut.tempFiles, true),
  'bekleyen geri yuklemenin staging dosyasi kalir',
);
assert.ok(
  !isStaleBackupLeftover('backup_2026-01-01T06-00-00-000Z.db.enc', ago(300), cut.tempFiles, false),
  'yedegin kendisi degil',
);
assert.ok(
  !isStaleBackupLeftover('imported_x.db.enc', ago(300), cut.tempFiles, false),
  'ice aktarilan degil',
);
assert.ok(
  !isStaleBackupLeftover('notlar.txt', ago(300), cut.tempFiles, false),
  'baska dosya degil',
);

// --- Geri yukleme oncesi kopyalar: yalniz en yenisi kalir ---
assert.ok(isPreRestoreCopy('ado.pre-restore-1760000000000.db'));
assert.ok(!isPreRestoreCopy('ado.db') && !isPreRestoreCopy('ado.pre-restore-x.db'));
assert.deepStrictEqual(
  preRestoreToDelete([
    'ado.pre-restore-1700000000000.db',
    'ado.pre-restore-1760000000000.db',
    'ado.pre-restore-900000000000.db',
    'ado.db',
    'ado.restore-incoming.db',
  ]).sort(),
  ['ado.pre-restore-1700000000000.db', 'ado.pre-restore-900000000000.db'],
  'sayisal zamana gore en yeni kalir (harf sirasina gore degil)',
);
assert.deepStrictEqual(preRestoreToDelete(['ado.pre-restore-1.db']), [], 'tek kopya kalir');
assert.deepStrictEqual(preRestoreToDelete([]), []);

// --- Gunluk dosyalari ---
assert.ok(isLogFile('backend-error.log') && isLogFile('backend-error.log.1'));
assert.ok(!isLogFile('ado.db') && !isLogFile('catalog.json'));

console.log('✓ maintenance.rules self-check OK');

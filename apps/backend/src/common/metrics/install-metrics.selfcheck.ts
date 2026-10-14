// Saglik bilgisi toplayicisinin self-check'i:
// `ts-node --transpile-only src/common/metrics/install-metrics.selfcheck.ts`
import 'reflect-metadata';
import assert from 'node:assert';
import { InstallMetricsService } from './install-metrics.service';

async function main() {
  const metrics = new InstallMetricsService();

  // Saglayici yokken hepsi null.
  assert.deepStrictEqual(await metrics.collect(), {
    dbBytes: null,
    backupsBytes: null,
    freeDiskBytes: null,
    lastBackupAt: null,
    lastCloudBackupAt: null,
  });

  metrics.register('yedek', async () => ({
    dbBytes: 1000,
    backupsBytes: 5000,
    freeDiskBytes: 9_000_000,
    lastBackupAt: '2026-10-14T06:00:00.000Z',
  }));
  metrics.register('bulut-yedegi', async () => ({ lastCloudBackupAt: '2026-10-14T06:05:00.000Z' }));
  // Hata veren saglayici digerlerini dusurmez; bilinmeyen alanlar alinmaz.
  metrics.register('bozuk', async () => {
    throw new Error('disk okunamadi');
  });
  metrics.register('fazla', async () => ({ secret: 'x' }) as never);

  const merged = await metrics.collect();
  assert.equal(merged.dbBytes, 1000);
  assert.equal(merged.backupsBytes, 5000);
  assert.equal(merged.lastCloudBackupAt, '2026-10-14T06:05:00.000Z');
  assert.ok(!('secret' in merged), 'bilinmeyen alan heartbeat-e girmez');

  // Ayni adla yeniden kayit oncekinin yerine gecer.
  metrics.register('yedek', async () => ({ dbBytes: 2000 }));
  const replaced = await metrics.collect();
  assert.equal(replaced.dbBytes, 2000);
  assert.equal(replaced.backupsBytes, null, 'eski saglayicinin alanlari kalmaz');

  console.log('✓ install-metrics self-check OK');
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

// Kendi backend'ini acan e2e testlerini (test/*.spawn.e2e.mjs) sirayla calistirir.
// Yeni dosya kendiliginden katilir. Kullanim: node test/run-spawned.mjs (CI e2e isi)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const testDir = import.meta.dirname;
const backendDir = resolve(testDir, '..');
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.spawn.e2e.mjs'))
  .sort();

for (const file of files) {
  console.log(`\n▶ ${file}`);
  const run = spawnSync(process.execPath, [resolve(testDir, file)], {
    cwd: backendDir,
    stdio: 'inherit',
  });
  if (run.status !== 0) {
    console.error(`✗ e2e basarisiz: ${file}`);
    process.exit(run.status ?? 1);
  }
}
console.log(`\n✓ spawned e2e: ${files.length} dosya`);

// Masaustu self-check kosucusu: paket kokundeki selfcheck*.mjs dosyalari (Electron'suz).
// Yeni dosya (or. selfcheck.startup.mjs) kendiliginden katilir. Kullanim: node scripts/selfchecks.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = readdirSync(root)
  .filter((name) => /^selfcheck.*\.mjs$/.test(name))
  .sort();

for (const file of files) {
  const run = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`✗ self-check basarisiz: ${file}`);
    process.exit(run.status ?? 1);
  }
}
console.log(`✓ desktop: ${files.length} self-check dosyasi`);

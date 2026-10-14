// Frontend self-check kosucusu: src/**/*.selfcheck.ts (node --experimental-strip-types).
// Yeni self-check dosyasi kendiliginden katilir. Kullanim: node scripts/selfchecks.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(join(root, 'src'))
  .filter((file) => file.endsWith('.selfcheck.ts'))
  .map((file) => relative(root, file).split(sep).join('/'))
  .sort();

for (const file of files) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', file], {
    cwd: root,
    stdio: 'inherit',
  });
  if (run.status !== 0) {
    console.error(`✗ self-check basarisiz: ${file}`);
    process.exit(run.status ?? 1);
  }
}
console.log(`✓ frontend: ${files.length} self-check`);

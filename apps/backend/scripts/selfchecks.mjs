// Backend self-check kosucusu: once ici self-check'li eski dosyalar, sonra src/**/*.selfcheck.ts.
// Yeni self-check dosyasi kendiliginden katilir; paralel calisan dallar ayni satiri duzenlemez.
// Kullanim: node scripts/selfchecks.mjs  (package.json test:unit)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// `require.main === module` blogu tasiyan, adi .selfcheck.ts olmayan dosyalar.
const LEGACY = [
  'src/payments/payments.calc.ts',
  'src/orders/orders.calc.ts',
  'src/reports/reports.calc.ts',
  'src/license/license.keys.ts',
  'src/license/license.paths.ts',
  'src/common/util/install-id.ts',
  'src/auth/recovery.code.ts',
  'src/backup/backup.keys.ts',
  'src/tls/tls.certs.ts',
  'src/printing/print-text.ts',
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const discovered = walk(join(root, 'src'))
  .filter((file) => file.endsWith('.selfcheck.ts'))
  .map((file) => relative(root, file).split(sep).join('/'))
  .sort();
const files = [...LEGACY, ...discovered];
const tsNode = createRequire(join(root, 'package.json')).resolve('ts-node/dist/bin.js');

for (const file of files) {
  const run = spawnSync(process.execPath, [tsNode, '--transpile-only', file], {
    cwd: root,
    stdio: 'inherit',
  });
  if (run.status !== 0) {
    console.error(`✗ self-check basarisiz: ${file}`);
    process.exit(run.status ?? 1);
  }
}
console.log(`✓ backend: ${files.length} self-check`);

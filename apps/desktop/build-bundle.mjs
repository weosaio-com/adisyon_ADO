// Masaustu paketi icin kendi-yeten bundle hazirlar (electron-builder oncesi).
// Kullanim: node build-bundle.mjs --profile test|prod  (cwd: apps/desktop)
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { PROFILES, validateAppConfig } from './app-config.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const bundle = resolve(import.meta.dirname, 'bundle');
const run = (cmd, env = {}) =>
  execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

// 0) Derleme profili: uzun derlemeden ONCE dogrula (eksik/hatali deger derlemeyi durdurur).
const { values: args } = parseArgs({ options: { profile: { type: 'string' } } });
if (!PROFILES.includes(args.profile)) {
  throw new Error(`--profile ${PROFILES.join('|')} gerekli (apps/desktop/profiles).`);
}
const profilePath = resolve(import.meta.dirname, 'profiles', `${args.profile}.json`);
const { config: appConfig, errors } = validateAppConfig(
  JSON.parse(readFileSync(profilePath, 'utf8')),
  { strict: true },
);
if (errors.length)
  throw new Error(`Profil gecersiz (${profilePath}):\n  - ${errors.join('\n  - ')}`);
if (!appConfig.licensePublicKey) {
  console.warn('UYARI: profilde lisans acik anahtari yok; bu kurulumda lisans girilemez.');
}

rmSync(bundle, { recursive: true, force: true });

// 1) Derle
run('npm --prefix apps/frontend run build');
run('npm --prefix apps/backend run build');

// 2) Kendi-yeten backend: hoisted linker gercek (junction'siz) node_modules uretir,
//    argon2 win32 native paketi de dahil olur.
run(
  `pnpm --filter @ado/backend --prod deploy "${join(bundle, 'backend')}" --legacy --config.node-linker=hoisted`,
);

// 3) pnpm deploy uretilen prisma client'i (.prisma) tasimaz; kokteki store'dan kopyala.
const req = createRequire(join(root, 'apps', 'backend', 'package.json'));
const prismaClient = join(
  dirname(req.resolve('@prisma/client/package.json')),
  '..',
  '..',
  '.prisma',
  'client',
);
cpSync(prismaClient, join(bundle, 'backend', 'node_modules', '.prisma', 'client'), {
  recursive: true,
});
cpSync(
  join(root, 'prisma', 'schema', 'migrations'),
  join(bundle, 'backend', 'prisma', 'migrations'),
  { recursive: true },
);

// 4) Frontend dist — backend bunu dist/main.js'e gore ../../frontend/dist yolundan sunar.
cpSync(join(root, 'apps', 'frontend', 'dist'), join(bundle, 'frontend', 'dist'), {
  recursive: true,
});

// 5) Sablon DB: bos sema (migrate deploy) + KULLANICISIZ seed (rol/izin/sube).
// Sifre env'leri bilerek bosaltilir -> ilk acilista uygulama kurulum sihirbazini gosterir.
const DATABASE_URL = 'file:' + join(bundle, 'template.db').replaceAll('\\', '/');
const templateDb = new DatabaseSync(join(bundle, 'template.db'));
templateDb.exec(
  'CREATE TABLE "_ado_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL)',
);
for (const name of readdirSync(join(root, 'prisma', 'schema', 'migrations')).sort()) {
  const sqlPath = join(root, 'prisma', 'schema', 'migrations', name, 'migration.sql');
  if (!existsSync(sqlPath)) continue;
  templateDb.exec('BEGIN IMMEDIATE');
  try {
    templateDb.exec(readFileSync(sqlPath, 'utf8'));
    templateDb
      .prepare('INSERT INTO "_ado_migrations" ("name", "applied_at") VALUES (?, ?)')
      .run(name, new Date().toISOString());
    templateDb.exec('COMMIT');
  } catch (error) {
    templateDb.exec('ROLLBACK');
    throw error;
  }
}
templateDb.close();
// Bos string: dotenv mevcut degiskeni ezmez, env semasi ''=yok sayar -> kullanici olusmaz.
run('npm --prefix apps/backend run seed', {
  DATABASE_URL,
  SEED_OWNER_PASSWORD: '',
  SEED_WAITER_PIN: '',
});

// 6) Profil -> resources/app-config.json (main.mjs okur, backend'e ortam degiskeni olarak verir).
writeFileSync(join(bundle, 'app-config.json'), `${JSON.stringify(appConfig, null, 2)}\n`);

console.log(`\nbundle hazir (${appConfig.profile} profili):`, bundle);

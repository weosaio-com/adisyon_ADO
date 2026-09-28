import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Her test dosyasi temiz bir veritabaniyla baslar (depolama dosya basina ayri).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

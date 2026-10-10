import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Lisans testleri icin her calistirmada yeni bir Ed25519 cifti: acik anahtar Worker'a baglanir,
// ozel anahtar yalniz testlerin lisans imzalamasi icindir (hicbir yere yazilmaz).
const license = generateKeyPairSync('ed25519');

// Testler gercek Workers calisma zamaninda (workerd) kosar; D1 ve R2 yerel ve dosya basina ayri.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: 'test-admin-token-0123456789',
          LICENSE_PUBLIC_KEY: license.publicKey
            .export({ format: 'der', type: 'spki' })
            .toString('base64'),
          TEST_LICENSE_PRIVATE_KEY: license.privateKey
            .export({ format: 'der', type: 'pkcs8' })
            .toString('base64'),
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL('./migrations', import.meta.url)),
          ),
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});

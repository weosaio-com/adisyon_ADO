import type { D1Migration } from 'cloudflare:test';
import type { Env as AppBindings } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {
      TEST_MIGRATIONS: D1Migration[];
      /** Testlerin lisans imzaladigi Ed25519 ozel anahtari (base64 PKCS8; vitest.config.ts). */
      TEST_LICENSE_PRIVATE_KEY: string;
    }
  }
}

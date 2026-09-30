import { defineConfig, devices } from '@playwright/test';

// Tarayici seviyesi offline E2E: gercek PWA (IndexedDB outbox + service worker + reconnect).
// Backend :3001'de build edilmis frontend'i sunar; sunucuyu CI/gelistirici baslatir.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  testDir: './e2e',
  // QR menu testi bulutu (apps/cloud `wrangler dev`) ister: E2E_CLOUD_URL yoksa atlanir (CI: e2e-cloud).
  testIgnore: process.env.E2E_CLOUD_URL ? [] : ['**/qr-menu.spec.ts'],
  timeout: 30_000,
  fullyParallel: false, // paylasilan seed DB -> sirali kosum
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL,
    storageState: './e2e/.auth/owner.json',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

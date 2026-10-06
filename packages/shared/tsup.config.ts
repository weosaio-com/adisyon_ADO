import { defineConfig } from 'tsup';

/**
 * @ado/shared cift-format derlenir (ESM + CJS + d.ts).
 * Neden: ESM kaynak (`.js` uzantili import'lar) CommonJS backend'i (NestJS) kirmasin.
 * Backend `require` -> dist/index.cjs, frontend (Vite) `import` -> dist/index.js.
 * Ek giris noktalari ulid'i ice almaz: `@ado/shared/menu` (zod semalari; Cloudflare Worker) ve
 * `@ado/shared/menu-core` (bagimliliksiz sabitler/yardimcilar; tarayici uygulamalari).
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/menu.ts', 'src/menu-core.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});

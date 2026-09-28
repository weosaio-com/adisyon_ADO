import { defineConfig } from 'tsup';

/**
 * @ado/shared cift-format derlenir (ESM + CJS + d.ts).
 * Neden: ESM kaynak (`.js` uzantili import'lar) CommonJS backend'i (NestJS) kirmasin.
 * Backend `require` -> dist/index.cjs, frontend (Vite) `import` -> dist/index.js.
 * `menu` ayri giris noktasidir (`@ado/shared/menu`): ulid'i ice almaz, Cloudflare Worker ve
 * qr-web yalniz menu sozlesmesini yukler.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/menu.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});

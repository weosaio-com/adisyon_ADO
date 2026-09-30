import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Musteri menusu + panel. Uretimde apps/cloud Worker'inin statik varliklaridir (wrangler.jsonc);
// gelistirmede /api ve /img istekleri `wrangler dev`'e (8787) gider -> tek koken, cerez calisir.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/img': 'http://127.0.0.1:8787',
    },
  },
});

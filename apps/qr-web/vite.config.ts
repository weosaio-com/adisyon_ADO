import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Musteri menusu + panel. Uretimde apps/cloud Worker'inin statik varliklaridir (wrangler.jsonc);
// gelistirmede /api ve /img istekleri `wrangler dev`'e (8787) gider -> tek koken, cerez calisir.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Yalniz isletme paneli yuklenebilir uygulamadir: SW'yi PanelApp `/panel` kapsamiyla kaydeder,
    // manifest baglantisini da o ekler (src/panel/pwa.ts). Musteri sayfasi /m/* SW'ye girmez.
    VitePWA({
      injectRegister: false,
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: 'index.html',
        navigateFallbackAllowlist: [/^\/panel(\/|$)/],
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // Gorsel adi icerik ozetidir (degismez): bir kez gorulen gorsel internetsiz de acilir.
        runtimeCaching: [
          {
            urlPattern: /\/img\/[0-9a-f]{64}\.(?:jpg|png|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'panel-images',
              expiration: { maxEntries: 500, maxAgeSeconds: 90 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/img': 'http://127.0.0.1:8787',
    },
  },
});

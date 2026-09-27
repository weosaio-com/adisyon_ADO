import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

// Dev'de /api istekleri backend'e (3001) proxy'lenir -> CORS yok.
// Prod'da backend, build edilmis frontend'i ayni origin'den servis eder.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA: app-shell precache -> tablet offline'da uygulama acilir. OFFLINE_DESIGN.md §3, K5
    VitePWA({
      registerType: 'autoUpdate',
      // public/icons (kaynak: icon.svg) -> app-shell ile birlikte onbellege alinir.
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      workbox: {
        // Yeni SW aktif olunca acik sayfalari HEMEN kontrol et -> ilk yenileme offline calisir.
        clientsClaim: true,
        skipWaiting: true,
        // Offline'da rota yenilemesi -> app-shell (index.html). /api haric.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/],
      },
      manifest: {
        name: 'Adisyon POS',
        short_name: 'Adisyon',
        lang: 'tr',
        display: 'standalone',
        start_url: '/',
        theme_color: '#1e293b',
        background_color: '#f1f5f9',
        // Kurulabilirlik (ana ekrana ekle) icin 192/512 + maskelenebilir simge gerekir.
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true, // LAN'dan (garson cihazlari) erisilebilir
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
});

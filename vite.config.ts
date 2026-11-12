import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Relative base so the static build runs from any path (GitHub Pages, S3, a site gateway, or file hosting).
export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt': src/ui/shell/UpdatePrompt.tsx (virtual:pwa-register/react) applies a new build at once on a fresh page
      // load and otherwise offers a reload toast, so a stale cached build is never left on screen. 'auto' injects no
      // register script because the virtual module is imported.
      registerType: 'prompt',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Zill — Heat-strain early warning',
        short_name: 'Zill',
        description: 'Worker-first heat-strain early warning for outdoor and industrial workers.',
        theme_color: '#0b1220',
        background_color: '#0b1220',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/zill-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/zill-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // App shell + the small datasets needed to run fully offline. The large multi-year weather archive
        // is fetched on demand and cached at runtime instead of being precached.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}', 'data/weather/demo-days.json', 'data/validation/*.json'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        runtimeCaching: [
          // Script fonts for the worker languages (index.html): the stylesheet and the font files are immutable per URL.
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'zill-google-fonts-css',
              expiration: { maxEntries: 10, maxAgeSeconds: 365 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'zill-google-fonts-files',
              expiration: { maxEntries: 60, maxAgeSeconds: 365 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/data\/weather\/.*\.json$/,
            handler: 'CacheFirst',
            options: { cacheName: 'zill-weather-archive', expiration: { maxEntries: 120 } },
          },
          {
            urlPattern: /^https:\/\/api\.open-meteo\.com\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'zill-forecast',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 60, maxAgeSeconds: 3 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
})

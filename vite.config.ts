import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.ts';
import { extensionAssets } from './scripts/extension-assets.ts';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [preact(), extensionAssets(), crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
  },
  // CRXJS uses a websocket for HMR of the service worker in dev.
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});

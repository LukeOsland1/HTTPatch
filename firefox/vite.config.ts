// Firefox build — deliberately separate from the Chrome pipeline so the shipping
// Chrome build (vite.config.ts + @crxjs/vite-plugin) is never touched.
//
// It reuses the browser-free core (src/core/*) and the shared Preact UI
// unchanged, and swaps ONLY the thin browser-touching modules for their Firefox
// (`browser.*`) variants via resolve.alias below. Output goes to dist-firefox/,
// which web-ext then packages into a signed .xpi.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { firefoxManifest } from './manifest.ts';
import { extensionAssets } from '../scripts/extension-assets.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = fileURLToPath(new URL('../src', import.meta.url));
const ff = fileURLToPath(new URL('.', import.meta.url));

const ICONS = ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'];

/** Emit the Firefox manifest.json and copy the (non-imported) icon assets. */
function emitFirefoxAssets() {
  return {
    name: 'emit-firefox-assets',
    generateBundle() {
      // @ts-expect-error — `this.emitFile` is the Rollup plugin context.
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(firefoxManifest, null, 2),
      });
      for (const name of ICONS) {
        // @ts-expect-error — `this.emitFile` is the Rollup plugin context.
        this.emitFile({
          type: 'asset',
          fileName: `icons/${name}`,
          source: readFileSync(resolve(root, 'icons', name)),
        });
      }
    },
  };
}

export default defineConfig({
  root,
  // Extension pages load over moz-extension://, so asset URLs must be relative.
  base: './',
  resolve: {
    alias: [
      // Firefox variants of the browser-touching modules (most specific first).
      { find: '@/core/storage', replacement: resolve(ff, 'storage.ts') },
      { find: '@/core/active-tab', replacement: resolve(ff, 'active-tab.ts') },
      { find: '@/core/tab-assignments', replacement: resolve(ff, 'tab-assignments.ts') },
      { find: '@/core/sync-area', replacement: resolve(ff, 'sync-area.ts') },
      { find: '@/core/apply', replacement: resolve(ff, 'apply.ts') },
      { find: '@/messaging/messages', replacement: resolve(ff, 'messages.ts') },
      // Everything else resolves to the shared source.
      { find: '@', replacement: src },
    ],
  },
  plugins: [preact(), emitFirefoxAssets(), extensionAssets()],
  build: {
    outDir: resolve(root, 'dist-firefox'),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        popup: resolve(root, 'src/popup/index.html'),
        options: resolve(root, 'src/options/index.html'),
        background: resolve(ff, 'background.ts'),
      },
      output: {
        // Background is referenced by name in the manifest, so it needs a stable
        // filename; everything else is hashed under assets/.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});

import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      // Bundle our own workspace code: the packaged app ships no
      // node_modules/@pi (prepare-pack removes the workspace symlinks and
      // electron-builder collects nothing for workspace:* entries), so a
      // bare import here becomes ERR_MODULE_NOT_FOUND in the packaged
      // main process — a crash dialog on first launch. Externalize all npm
      // packages, especially @earendil-works/pi-coding-agent which contains
      // native .node addons and WASM files that cannot be bundled by Vite.
      exclude: ['@pi/sdk-wrapper', '@pi/types'],
    })],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        // Resolve workspace packages to their compiled dist so that
        // electron-vite can bundle them. The dist must be built first
        // (via `pnpm build` or `turbo build` from the repo root).
        '@pi/sdk-wrapper': resolve(__dirname, '../../packages/sdk-wrapper/dist'),
        '@pi/sdk-wrapper/adapters': resolve(__dirname, '../../packages/sdk-wrapper/dist/adapters/index.js'),
        '@pi/types': resolve(__dirname, '../../packages/types/dist'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Voice inference runs in its own utility process (crash isolation,
          // no main-thread stalls). It is loaded by path, not imported.
          'voice-worker': resolve(__dirname, 'src/main/voice/worker.ts'),
        },
        output: {
          // Output ESM so dynamic imports work with externalized ESM-only packages
          // like @earendil-works/pi-coding-agent (which has "type": "module").
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: 'chunks/[name]-[hash].mjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Preload for plugin WebContentsViews — plugin panels are top-level
          // frames, so they need their own bridge (see src/preload/plugin-view.ts).
          'plugin-view': resolve(__dirname, 'src/preload/plugin-view.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, '../../packages/ui/src'),
        '@pi/ui': resolve(__dirname, '../../packages/ui/src'),
        '@pi/sdk-wrapper': resolve(__dirname, '../../packages/sdk-wrapper/dist'),
        '@pi/types': resolve(__dirname, '../../packages/types/dist'),
      },
    },
    plugins: [react()],
  },
});

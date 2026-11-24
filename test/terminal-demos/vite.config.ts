import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Reuse the existing docs dependencies without making this a workspace or site route.
const docsRequire = createRequire(new URL('../../docs/package.json', import.meta.url));
const vitepressRequire = createRequire(docsRequire.resolve('vitepress'));
const { default: vue } = await import(vitepressRequire.resolve('@vitejs/plugin-vue'));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      vue: join(
        dirname(vitepressRequire.resolve('vue/package.json')),
        'dist/vue.runtime.esm-bundler.js',
      ),
      '@iconify/vue': docsRequire.resolve('@iconify/vue'),
    },
  },
  server: { host: '127.0.0.1', port: 41_742, strictPort: true },
  build: { outDir: '../../playground-local/terminal-demos-build', emptyOutDir: true },
});

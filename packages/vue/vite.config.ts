import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: [
      'src/runtime/PageErrorBoundary.ts',
      'src/index.ts',
      'src/plugin.ts',
      'src/runtime/use-deferred.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      resolveDepSubpath: true,
      neverBundle: ['vue', 'vue/server-renderer', 'vite', 'void', 'void/*', '@vitejs/plugin-vue'],
    },
  },
});

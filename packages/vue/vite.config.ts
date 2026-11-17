import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: 'vp pack',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
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

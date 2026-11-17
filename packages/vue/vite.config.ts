import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      'prepare:test:islands': {
        command: 'node ../../test/prepare-fixture.ts vue islands',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:islands': {
        command: 'node ../../playground-local/.build-fixtures/vue-islands/build.mjs',
        dependsOn: ['prepare:test:islands'],
      },
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

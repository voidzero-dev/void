import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      'prepare:test:hydration': {
        command: 'node ../../test/prepare-fixture.ts solid hydration',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:hydration': {
        command: 'node ../../playground-local/.build-fixtures/solid-hydration/build.mjs',
        dependsOn: ['prepare:test:hydration'],
      },
      'prepare:test:islands': {
        command: 'node ../../test/prepare-fixture.ts solid islands',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:islands': {
        command: 'node ../../playground-local/.build-fixtures/solid-islands/build.mjs',
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
      'src/plugin.ts',
      'src/runtime/index.ts',
      'src/runtime/context.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      resolveDepSubpath: true,
      neverBundle: [
        'solid-js',
        'solid-js/web',
        'solid-js/store',
        'vite',
        'void',
        'void/*',
        'vite-plugin-solid',
      ],
    },
  },
});

import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      'prepare:test:islands': {
        command: 'node ../../test/prepare-fixture.ts svelte islands',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:islands': {
        command: 'node ../../playground-local/.build-fixtures/svelte-islands/build.mjs',
        dependsOn: ['prepare:test:islands'],
      },
      'prepare:test:mixed': {
        command: 'node ../../test/prepare-fixture.ts svelte mixed',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:mixed': {
        command: 'node ../../playground-local/.build-fixtures/svelte-mixed/build.mjs',
        dependsOn: ['prepare:test:mixed'],
      },
      build: {
        command: 'vp pack',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  pack: {
    entry: ['src/plugin.ts'],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      resolveDepSubpath: true,
      neverBundle: ['svelte', 'svelte/*', 'vite', 'void', 'void/*', '@sveltejs/vite-plugin-svelte'],
    },
  },
});

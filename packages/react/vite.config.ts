import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      'prepare:test:markdown-scripts': {
        command: 'node ../../test/prepare-fixture.ts react markdown-scripts',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:markdown-scripts': {
        command: 'node ../../playground-local/.build-fixtures/react-markdown-scripts/build.mjs',
        dependsOn: ['prepare:test:markdown-scripts'],
      },
      'prepare:test:islands': {
        command: 'node ../../test/prepare-fixture.ts react islands',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:islands': {
        command: 'node ../../playground-local/.build-fixtures/react-islands/build.mjs',
        dependsOn: ['prepare:test:islands'],
      },
      'prepare:test:bare': {
        command: 'node ../../test/prepare-fixture.ts react bare',
        dependsOn: ['build', '@void/md#build'],
        cache: false,
      },
      'build:test:bare': {
        command: 'node ../../playground-local/.build-fixtures/react-bare/build.mjs',
        dependsOn: ['prepare:test:bare'],
      },
      build: {
        command: 'vp pack',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  pack: {
    entry: [
      'src/index.ts',
      'src/plugin.ts',
      'src/runtime/pages-client.ts',
      'src/runtime/pages-server.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      resolveDepSubpath: true,
      neverBundle: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/server',
        'react-dom/client',
        'vite',
        'void',
        'void/*',
        '@vitejs/plugin-react',
      ],
    },
  },
});

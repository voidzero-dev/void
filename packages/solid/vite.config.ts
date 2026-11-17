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

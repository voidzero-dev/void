import { defineConfig } from 'vite-plus';

export default defineConfig({
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

import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: [
      'src/index.ts',
      'src/plugin.ts',
      'src/runtime/pages-client.tsx',
      'src/runtime/pages-server.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      resolveDepSubpath: true,
      neverBundle: ['hono', 'hono/*', 'vite', 'void', 'void/*'],
    },
  },
});

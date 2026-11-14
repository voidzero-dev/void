import { defineConfig } from 'vite-plus';
export default defineConfig({
  pack: {
    entry: [
      'src/index.ts',
      'src/jsx-runtime.ts',
      'src/plugin.ts',
      'src/server.ts',
      'src/client.ts',
    ],
    tsconfig: 'tsconfig.build.json',
    format: 'esm',
    dts: true,
    clean: true,
    deps: { neverBundle: ['vite', 'void', 'void/*', 'oxc-parser', 'magic-string', 'entities'] },
  },
});

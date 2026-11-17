import { cpSync } from 'node:fs';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/plugin.ts', 'src/runtime/index.ts'],
    format: 'esm',
    dts: true,
    clean: true,
    deps: { resolveDepSubpath: true, neverBundle: ['vite', 'void'] },
    onSuccess() {
      cpSync('src/theme', 'dist/theme', { recursive: true });
    },
  },
});

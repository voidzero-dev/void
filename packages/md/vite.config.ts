import { cpSync } from 'node:fs';
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

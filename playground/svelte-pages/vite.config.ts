import { voidSvelte } from '@void/svelte/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: 'vp build',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  plugins: [voidPlugin(), voidSvelte()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ['valibot'] },
});

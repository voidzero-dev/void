import { voidSolid } from '@void/solid/plugin';
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
  plugins: [voidPlugin(), voidSolid()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ['valibot'] },
});

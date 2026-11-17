import { voidReact } from '@void/react/plugin';
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
  plugins: [voidPlugin(), voidReact()],
  optimizeDeps: { include: ['valibot'] },
});

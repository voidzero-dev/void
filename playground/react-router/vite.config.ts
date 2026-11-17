import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: 'node build.mjs',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  plugins: [voidPlugin(), reactRouter()],
});

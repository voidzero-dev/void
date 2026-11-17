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
});

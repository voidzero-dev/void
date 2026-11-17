import { voidMarkdown } from '@void/md/plugin';
import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

// Markdown-only: every page is an implicit island with no client-side JS.
export default defineConfig({
  run: {
    tasks: {
      build: {
        command: 'vp build',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  plugins: [voidPlugin(), voidReact(), voidMarkdown()],
});

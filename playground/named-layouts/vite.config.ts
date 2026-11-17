import { voidMarkdown } from '@void/md/plugin';
import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidReact(), voidMarkdown()],
});

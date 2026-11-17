import { voidSvelte } from '@void/svelte/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ['valibot'] },
});

import { voidVue } from '@void/vue/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ['valibot'] },
});

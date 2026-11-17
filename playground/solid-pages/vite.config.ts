import { voidSolid } from '@void/solid/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ['valibot'] },
});

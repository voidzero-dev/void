import { voidHono } from '@void/hono/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidHono()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ['valibot'] },
});

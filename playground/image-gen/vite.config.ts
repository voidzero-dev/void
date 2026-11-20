import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  define: {
    __IMAGE_MEMORY_DEMO__: JSON.stringify(process.env.VOID_IMAGE_MEMORY_DEMO === '1'),
    __IMAGE_RESPONSE_SOURCE_ROOT__: JSON.stringify(new URL('./', import.meta.url).href),
  },
  plugins: [voidPlugin(), voidReact()],
});

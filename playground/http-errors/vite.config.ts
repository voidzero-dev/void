import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  define: {
    __HTTP_ERRORS_SOURCE_ROOT__: JSON.stringify(new URL('./', import.meta.url).href),
  },
  plugins: [voidPlugin(), voidReact()],
});

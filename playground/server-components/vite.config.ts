import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig(({ command }) => ({
  plugins: [voidPlugin()],
  define: {
    'import.meta.env.DEMO_SOURCE_BASE': JSON.stringify(
      command === 'serve'
        ? `vscode://file${new URL('./', import.meta.url).pathname}`
        : 'https://github.com/voidzero-dev/void/blob/server-components/playground/server-components/',
    ),
  },
}));

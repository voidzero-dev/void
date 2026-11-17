import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), reactRouter()],
});

import { voidView } from '@void/view/plugin';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';
export default defineConfig({ plugins: [voidPlugin(), voidView()] });

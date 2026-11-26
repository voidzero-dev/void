import analog from '@analogjs/platform';
import type {} from 'nitro-cloudflare-dev';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  resolve: {
    mainFields: ['module'],
  },
  plugins: [
    analog({
      ssr: true,
      nitro: {
        preset: 'cloudflare-module',
        modules: ['nitro-cloudflare-dev', 'void/nitro'],
        cloudflareDev: { configPath: './.void-wrangler.jsonc' },
      },
    }),
    voidPlugin(),
  ],
});

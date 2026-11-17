import { defineNuxtConfig } from 'nuxt/config';
import { resolve } from 'pathslash';
import type { PluginOption } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineNuxtConfig({
  compatibilityDate: '2026-02-24',
  // Server routes are also typed in the app project, which reads Nuxt's aliases.
  alias: {
    '@schema': resolve(import.meta.dirname, 'db/schema.ts'),
  },
  nitro: {
    preset: 'cloudflare-module',
    modules: ['void/nitro'],
    cloudflare: { dev: { configPath: './.void-wrangler.jsonc' } },
    // Remove when Nuxt ships https://github.com/nuxt/nuxt/commit/21657c6fcf.
    externals: {
      inline: [/[\\/]node_modules[\\/]nuxt[\\/]dist[\\/]/],
    },
  },
  vite: {
    plugins: [voidPlugin() as unknown as PluginOption],
  },
});

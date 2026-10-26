import cloudflare from '@astrojs/cloudflare';
import { defineConfig, sessionDrivers } from 'astro/config';
import { voidPlugin } from 'void';

function vite8AstroDevToolbarCompat() {
  return {
    name: 'playground-astro:vite8-dev-toolbar-compat',
    config(config) {
      const plugins = config.optimizeDeps?.esbuildOptions?.plugins;

      if (plugins) {
        config.optimizeDeps.esbuildOptions.plugins = plugins.filter(
          (plugin) => plugin?.name !== 'astro:strip-toolbar-sourcemap',
        );
      }
    },
  };
}

export default defineConfig({
  adapter: cloudflare({ configPath: './.void-wrangler.jsonc' }),
  session: {
    driver: sessionDrivers.lruCache(),
  },
  vite: {
    // These server imports are discovered on the first request. Optimize them
    // up front to avoid serial worker reloads while the smoke server warms up.
    // drizzle-orm is Void's dependency, not this app's, so name it through void.
    optimizeDeps: {
      include: ['astro/logger/console', 'void > drizzle-orm/sqlite-core'],
    },
    plugins: [voidPlugin(), vite8AstroDevToolbarCompat()],
  },
});

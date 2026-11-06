import type { Plugin } from 'vite';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin, type PrefetchConfig } from './plugin-pages.ts';

export type VoidHonoOptions = Readonly<{
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
}>;

// Pages, layouts and islands are compiled for Hono JSX whatever the app's
// tsconfig says, and share one copy of Hono with the adapter runtime: Hono JSX
// matches contexts by identity.
function configPlugin(): Plugin {
  return {
    name: 'void-hono:config',
    config() {
      return {
        oxc: { jsx: { runtime: 'automatic', importSource: 'hono/jsx' } },
        resolve: { dedupe: ['hono'] },
      };
    },
  };
}

export function voidHono(options?: VoidHonoOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  return [
    configPlugin(),
    pagesPlugin(pagesDir, {
      root,
      viewTransitions: options?.viewTransitions,
      prefetch: options?.prefetch,
    }),
    ...islandsPlugin(pagesDir, { root }),
  ];
}

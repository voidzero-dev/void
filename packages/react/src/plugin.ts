import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';
import type { PrefetchConfig } from './plugin-pages.ts';

export type VoidReactOptions = Readonly<{
  react?: Parameters<typeof react>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
  deployRecovery?: boolean;
}>;

export function voidReact(options?: VoidReactOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  return [
    ...react(options?.react),
    // Spread so adapter options the pages plugin owns reach it without per-option glue.
    pagesPlugin(pagesDir, { ...options, root }),
    ...islandsPlugin(pagesDir, { root }),
  ];
}

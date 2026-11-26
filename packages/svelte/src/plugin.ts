import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin } from 'vite';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';
import type { PrefetchConfig } from './plugin-pages.ts';

export type VoidSvelteOptions = Readonly<{
  svelte?: Parameters<typeof svelte>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
  deployRecovery?: boolean;
}>;

export function voidSvelte(options?: VoidSvelteOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  return [
    ...(svelte(options?.svelte) as ReadonlyArray<Plugin>),
    // Spread so adapter options the pages plugin owns reach it without per-option glue.
    pagesPlugin(pagesDir, { ...options, root }),
    ...islandsPlugin(pagesDir, { root }),
  ];
}

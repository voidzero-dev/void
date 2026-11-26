import vue from '@vitejs/plugin-vue';
import type { Plugin } from 'vite';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';
import type { PrefetchConfig } from './plugin-pages.ts';

export type VoidVueOptions = Readonly<{
  vue?: Parameters<typeof vue>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
  deployRecovery?: boolean;
}>;

export function voidVue(options?: VoidVueOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  return [
    vue(options?.vue) as Plugin,
    ...pagesPlugin(
      pagesDir,
      // Spread so adapter options the pages plugin owns reach it without per-option glue.
      { ...options, root },
      options?.vue?.script?.babelParserPlugins,
    ),
    ...islandsPlugin(pagesDir, { root }),
  ];
}

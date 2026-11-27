import vue from '@vitejs/plugin-vue';
import { resolve } from 'pathslash';
import { normalizePath } from 'vite';
import type { Plugin } from 'vite';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';
import type { PrefetchConfig } from './plugin-pages.ts';

export type VoidVueOptions = Readonly<{
  vue?: Parameters<typeof vue>[0];
  /** Project-relative path to a module that default-exports Vue app setup. */
  appSetup?: string;
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
  deployRecovery?: boolean;
}>;

export function voidVue(options?: VoidVueOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  const file = options?.appSetup;
  const appSetup =
    file === undefined ? undefined : { id: normalizePath(resolve(root, file)), file };
  return [
    vue(options?.vue) as Plugin,
    ...pagesPlugin(
      pagesDir,
      { ...options, root, appSetup },
      options?.vue?.script?.babelParserPlugins,
    ),
    ...islandsPlugin(pagesDir, { root, appSetup }),
  ];
}

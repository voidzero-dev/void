import type { Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { resolvePagesDir } from 'void/pages';
import { islandsPlugin } from './plugin-islands.ts';
import { pagesPlugin } from './plugin-pages.ts';
import type { PrefetchConfig } from './plugin-pages.ts';

const SOLID_RUNTIME_PACKAGE = '@void/solid';

export type VoidSolidOptions = Readonly<{
  solid?: Parameters<typeof solid>[0];
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
  deployRecovery?: boolean;
}>;

// The runtime entry exports raw `.tsx` source. Without these hints, Vite's SSR
// dep optimizer prebundles the package with esbuild's default `automatic` JSX
// transform, emitting `import { jsx } from "react/jsx-runtime"` — which then
// fails to resolve in a Solid project. Letting `vite-plugin-solid` see the
// source directly keeps JSX compilation correct. It also keeps one copy of the
// Solid context objects shared by the virtual page modules and user components.
function excludeRuntimeFromOptimizeDeps() {
  return { exclude: [SOLID_RUNTIME_PACKAGE] };
}

function configPlugin(): Plugin {
  return {
    name: 'void:solid:config',
    config() {
      return {
        optimizeDeps: excludeRuntimeFromOptimizeDeps(),
        ssr: {
          noExternal: [SOLID_RUNTIME_PACKAGE],
          optimizeDeps: excludeRuntimeFromOptimizeDeps(),
        },
      };
    },
    configEnvironment() {
      return { optimizeDeps: excludeRuntimeFromOptimizeDeps() };
    },
  };
}

export function voidSolid(options?: VoidSolidOptions): Array<Plugin> {
  const root = process.cwd();
  const pagesDir = resolvePagesDir(root);
  return [
    configPlugin(),
    solid({ ssr: true, ...options?.solid }),
    // Spread so adapter options the pages plugin owns reach it without per-option glue.
    pagesPlugin(pagesDir, { ...options, root }),
    ...islandsPlugin(pagesDir, { root }),
  ];
}

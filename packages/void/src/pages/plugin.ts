import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'pathslash';
import { loadEnv, normalizePath } from 'vite';
import type { Plugin, ResolvedConfig, UserConfig } from 'vite';
import { computePagesBuildId } from './build-id-source.ts';
import { PAGES_BUILD_ID_DEFINE } from './build-id.ts';
import { assertLinkPrefetchValue } from './prefetch.ts';
import type { CacheForInput, LinkPrefetchValue } from './prefetch.ts';
import { scanPages } from './scan.ts';
import { resolveStaticPageDataBuildOptions } from './static-data.ts';
import type { StaticPageDataBuildOptions } from './static-data.ts';
import type { PageScanResult } from './types.ts';

const RENDERER_ID = 'virtual:void-pages-renderer';
const CLIENT_ENTRY_ID = 'virtual:void-pages-client';

type PagesPluginContext = {
  isDev: boolean;
  scan: () => Promise<PageScanResult | null>;
};

/** The `prefetch` option of a framework adapter plugin. */
export type PrefetchConfig = {
  /** How a Link without its own `prefetch` prop prefetches. Accepts the same values. */
  defaultStrategy?: LinkPrefetchValue;
  hoverDelay?: number;
  cacheFor?: CacheForInput;
};

/** Options of a framework adapter's pages plugin. */
export type PagesPluginOptions = {
  root?: string;
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
  /**
   * Reload the destination when a tab navigates against a newer deployment.
   * Defaults to `true`. Turn it off to keep error boundaries in charge.
   */
  deployRecovery?: boolean;
};

/**
 * `prefetch` with its defaults: Links prefetch only when they ask to, with a 75 ms
 * hover delay and a 30 second cache.
 */
export function resolvePrefetchConfig(
  prefetch: PrefetchConfig | undefined,
): Required<PrefetchConfig> {
  const defaultStrategy = prefetch?.defaultStrategy ?? false;
  assertLinkPrefetchValue(defaultStrategy, 'prefetch.defaultStrategy');
  return {
    defaultStrategy,
    hoverDelay: prefetch?.hoverDelay ?? 75,
    cacheFor: prefetch?.cacheFor ?? '30s',
  };
}

type CreatePagesPluginOptions = {
  name: string;
  root?: string;
  deployRecovery?: boolean;
  generateRenderer: (scan: PageScanResult, isDev: boolean) => string;
  generateClient: (scan: PageScanResult, staticPageData: StaticPageDataBuildOptions) => string;
  config: (context: PagesPluginContext) => UserConfig | void | Promise<UserConfig | void>;
};

/**
 * The files that are not app source: the build output of every environment, and
 * assets that never take part in a chunk hash.
 */
function buildIdExcludes(root: string, userConfig: UserConfig): Array<string> {
  const dirs = new Set<string>(['dist']);
  const add = (dir: unknown) => {
    if (typeof dir === 'string') {
      dirs.add(dir);
    }
  };
  add(userConfig.build?.outDir);
  for (const environment of Object.values(userConfig.environments ?? {})) {
    add(environment?.build?.outDir);
  }
  add(userConfig.publicDir === undefined ? 'public' : userConfig.publicDir);
  return [...dirs].map((dir) => (isAbsolute(dir) ? dir : join(root, dir)));
}

/**
 * Values the client bundle inlines without appearing in a source file: the
 * env vars Vite exposes, and the app's `define` entries. Two builds that differ
 * only here still emit different chunks, so the id has to cover them.
 */
function clientBuildInputs(root: string, userConfig: UserConfig, mode: string): string {
  const envDir = typeof userConfig.envDir === 'string' ? userConfig.envDir : root;
  const env = Object.entries(loadEnv(mode, envDir, userConfig.envPrefix ?? 'VITE_')).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const define = Object.entries(userConfig.define ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ env, define });
}

/** Shared Vite lifecycle; adapters own their generated code and environment configuration. */
export function createPagesPlugin(pagesDir: string, options: CreatePagesPluginOptions): Plugin {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  let viteConfig: ResolvedConfig | undefined;
  const root = options.root ?? dirname(pagesDir);
  const normalizedPagesDir = normalizePath(pagesDir);
  // One id for the whole app: both bundles get it from the same define, and Vite
  // may resolve this config once per environment, so it is derived from the source
  // rather than minted here.
  let buildId: string | undefined;
  let pendingRescan: Promise<void> | null = null;
  async function rescanPages(): Promise<void> {
    pageScan = existsSync(pagesDir)
      ? await scanPages(root, { pagesDir, environment: isDev ? 'dev' : 'prod' })
      : null;
  }

  function runRescan(): Promise<void> {
    pendingRescan ??= rescanPages().finally(() => {
      pendingRescan = null;
    });
    return pendingRescan;
  }

  return {
    name: options.name,

    async buildStart() {
      await runRescan();
    },

    resolveId: {
      filter: { id: /^virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        return '\0' + id;
      },
    },

    load: {
      // Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void-pages-(renderer|client)$/ },
      async handler(id) {
        if (isDev && pendingRescan) {
          await pendingRescan;
        }
        if (!pageScan && existsSync(pagesDir)) {
          await runRescan();
        }
        if (id === '\0' + RENDERER_ID) {
          if (!pageScan) {
            return "export function renderPage() { throw new Error('No pages found'); }";
          }
          return options.generateRenderer(pageScan, isDev);
        }
        if (id === '\0' + CLIENT_ENTRY_ID) {
          if (!pageScan) {
            return '';
          }
          // Static page-data files are emitted only during production prerendering.
          const staticPageData = isDev
            ? { enabled: false, fastPath: false }
            : resolveStaticPageDataBuildOptions(root, { publicDir: viteConfig?.publicDir });
          return options.generateClient(pageScan, staticPageData);
        }
      },
    },

    configureServer(server) {
      async function handlePagesChange(
        path: string,
        event: 'add' | 'change' | 'unlink',
      ): Promise<void> {
        const normalizedPath = normalizePath(path);
        if (
          normalizedPath !== normalizedPagesDir &&
          !normalizedPath.startsWith(normalizedPagesDir + '/')
        ) {
          return;
        }
        if (event === 'change' && !normalizedPath.endsWith('.md')) {
          return;
        }
        try {
          await runRescan();
        } catch (error) {
          // Keep the last good scan; the next change rescans.
          server.config.logger.error(error instanceof Error ? error.message : String(error), {
            error: error instanceof Error ? error : undefined,
            timestamp: true,
          });
          return;
        }
        for (const env of Object.values(server.environments)) {
          for (const id of ['\0' + RENDERER_ID, '\0' + CLIENT_ENTRY_ID]) {
            const mod = env.moduleGraph.getModuleById(id);
            if (mod) {
              env.moduleGraph.invalidateModule(mod);
            }
          }
        }
      }

      server.watcher.on('add', (path) => handlePagesChange(path, 'add'));
      server.watcher.on('change', (path) => handlePagesChange(path, 'change'));
      server.watcher.on('unlink', (path) => handlePagesChange(path, 'unlink'));
    },

    configResolved(config) {
      viteConfig = config;
    },

    config(userConfig, env) {
      // Set before the early return: pages/ may be created after the server starts.
      const dev = env.command === 'serve';
      isDev = dev;
      if (!existsSync(pagesDir)) {
        return;
      }
      const pagesConfig = options.config({
        isDev,
        async scan() {
          await runRescan();
          return pageScan;
        },
      });
      const withBuildId = (resolved: UserConfig | void): UserConfig | void => {
        // The dev server serves a single build, so a tab never outlives the chunks
        // it imported, and an app without a client entry has no tab to recover.
        // Leaving the id undefined keeps every build check a no-op there.
        if (dev || resolved == null || options.deployRecovery === false) {
          return resolved;
        }
        buildId ??= computePagesBuildId(
          root,
          buildIdExcludes(root, userConfig),
          clientBuildInputs(root, userConfig, env.mode),
        );
        return {
          ...resolved,
          define: {
            ...resolved.define,
            [PAGES_BUILD_ID_DEFINE]: JSON.stringify(buildId),
            // An explicit app define wins: it pins the id for a fixture or forces
            // one that outlives this process, such as a commit sha.
            ...userConfig.define,
          },
        };
      };
      return pagesConfig instanceof Promise
        ? pagesConfig.then(withBuildId)
        : withBuildId(pagesConfig);
    },
  };
}

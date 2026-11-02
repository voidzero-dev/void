import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'pathslash';
import {
  isCSSRequest,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
  type UserConfig,
  type ViteDevServer,
} from 'vite';
import { findIslandImports, findStaticCssImports } from './island-imports.ts';
import { resolveEffectiveLayoutChain, scanPages } from './scan.ts';
import type { PageScanResult } from './types.ts';

export const ISLANDS_RENDERER_ID = 'virtual:void-islands-renderer';
export const ISLANDS_CLIENT_ENTRY_ID = 'virtual:void-islands-client';

export type IslandEntry = {
  componentPath: string;
  islandId: string;
  hydrate: string;
};

export {
  findIslandImports,
  findStaticCssImports,
  editIslandSource,
  type IslandSourceEdit,
} from './island-imports.ts';

type VoidMdPluginApi = {
  getClientScripts?(): Map<string, unknown>;
};

type VoidMdPlugin = {
  name: string;
  api?: VoidMdPluginApi;
};

function hasIslandImports(code: string, filename: string): boolean {
  return findIslandImports(code, filename).length > 0;
}

/** The pages whose Markdown script `@void/md` serves to the browser. */
export function mdClientScriptIds(resolvedConfig: ResolvedConfig | null): Set<string> {
  const mdPlugin = resolvedConfig?.plugins?.find(
    (plugin): plugin is VoidMdPlugin => plugin.name === 'void-md',
  );
  return new Set(mdPlugin?.api?.getClientScripts?.()?.keys() ?? []);
}

/** Resolve a relative import specifier to an absolute path by checking extensions. */
export function resolveSpecifier(
  specifier: string,
  importerDir: string,
  extensions: ReadonlyArray<string>,
): string | null {
  const base = normalizePath(resolve(importerDir, specifier));
  for (const ext of extensions) {
    if (existsSync(base + ext)) {
      return base + ext;
    }
  }
  if (existsSync(base)) {
    return base;
  }
  return null;
}

/** The islands that island pages and layouts import, for the islands client entry. */
export type IslandManifest = {
  readonly entries: Map<string, IslandEntry>;
  /**
   * Resolve an island import and record it. An import that does not resolve
   * keeps its specifier as its id and is not recorded.
   */
  register(
    specifier: string,
    importerDir: string,
    hydrate: string,
  ): { absPath: string | null; islandId: string };
  /**
   * Record the island imports of every island page and layout. The client
   * build may load the islands client entry before their transforms run.
   */
  registerPages(pageScan: PageScanResult, pagesDir: string): void;
};

/** `extensions` are tried, in order, for an island import without one. */
export function createIslandManifest(
  root: string,
  extensions: ReadonlyArray<string>,
): IslandManifest {
  const entries = new Map<string, IslandEntry>();

  function register(
    specifier: string,
    importerDir: string,
    hydrate: string,
  ): { absPath: string | null; islandId: string } {
    const absPath = resolveSpecifier(specifier, importerDir, extensions);
    if (!absPath) {
      return { absPath, islandId: specifier };
    }
    const islandId = normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, '');
    entries.set(islandId, { componentPath: absPath, islandId, hydrate });
    return { absPath, islandId };
  }

  return {
    entries,
    register,
    registerPages(pageScan, pagesDir) {
      const files = [
        ...pageScan.pages.map((page) => ({ filePath: page.componentPath, island: page.island })),
        ...pageScan.layouts,
        ...pageScan.namedLayouts,
      ];
      for (const entry of files) {
        if (!entry.island) {
          continue;
        }
        const filePath = resolve(pagesDir, entry.filePath);
        const code = readFileSync(filePath, 'utf-8');
        for (const islandImport of findIslandImports(code, filePath)) {
          register(islandImport.specifier, dirname(filePath), islandImport.hydrate);
        }
      }
    },
  };
}

/**
 * The island pages that match `componentPattern` and the layouts of every
 * island page. Without a server build, the islands client entry imports their
 * own styles and stylesheet imports.
 */
export function islandCssFiles(
  pageScan: PageScanResult,
  pagesDir: string,
  componentPattern: RegExp,
): Set<string> {
  const files = new Set<string>();
  for (const page of pageScan.pages) {
    if (!page.island) {
      continue;
    }
    if (componentPattern.test(page.componentPath)) {
      files.add(normalizePath(resolve(pagesDir, page.componentPath)));
    }
    for (const layout of resolveEffectiveLayoutChain(
      page,
      pageScan.layouts,
      pageScan.namedLayouts,
    )) {
      files.add(normalizePath(resolve(pagesDir, layout.filePath)));
    }
  }
  return files;
}

/**
 * Whether the app has island pages (`*.island.*` files or Markdown). Their
 * layouts can reach a stylesheet through a component, which only the module
 * graph shows, so the islands client entry is built for every such app.
 */
export async function hasIslandPages(root: string, pagesDir: string): Promise<boolean> {
  if (!existsSync(pagesDir)) {
    return false;
  }
  try {
    // Only builds call this, so count the pages a build keeps.
    return (await scanPages(root, { pagesDir, environment: 'prod' })).pages.some(
      (page) => page.island,
    );
  } catch {
    // buildStart scans the pages again and reports the error.
    return false;
  }
}

/** Build config that adds the islands client entry to the client build of an app with island pages. */
export async function islandsBuildConfig(
  root: string,
  pagesDir: string,
): Promise<UserConfig | undefined> {
  if (!(await hasIslandPages(root, pagesDir))) {
    return;
  }
  return {
    environments: {
      client: {
        build: {
          manifest: true,
          rollupOptions: {
            input: { 'islands-client': ISLANDS_CLIENT_ENTRY_ID },
          },
        },
      },
    },
  };
}

/**
 * The layouts of every island page, outermost first, then the pages. All
 * island pages share one production stylesheet, so layout styles come first.
 */
export function islandStyleRoots(pageScan: PageScanResult, pagesDir: string): Array<string> {
  const layouts = new Set<string>();
  const pages: Array<string> = [];
  for (const page of pageScan.pages) {
    if (!page.island) {
      continue;
    }
    for (const layout of resolveEffectiveLayoutChain(
      page,
      pageScan.layouts,
      pageScan.namedLayouts,
    )) {
      layouts.add(normalizePath(resolve(pagesDir, layout.filePath)));
    }
    pages.push(normalizePath(resolve(pagesDir, page.componentPath)));
  }
  return [...layouts, ...pages];
}

/** A stylesheet that a page links, not one imported as a string or a URL. */
function isLinkedStylesheet(id: string): boolean {
  if (!isCSSRequest(id)) {
    return false;
  }
  const query = id.indexOf('?');
  if (query === -1) {
    return true;
  }
  for (const param of id.slice(query + 1).split('&')) {
    const key = param.split('=')[0];
    if (key === 'inline' || key === 'url' || key === 'raw') {
      return false;
    }
  }
  return true;
}

type ModuleImports = { importedIds: ReadonlyArray<string> };

/**
 * Stylesheets the roots reach through static imports, in import order (like
 * the dev CSS collector). Returns null when the roots are not in the graph.
 * The walk also enters island components, as dev does: a layout can render
 * one without hydrating it, and a page links its styles before it hydrates.
 */
export function collectIslandStyles(
  getModuleInfo: (id: string) => ModuleImports | null,
  roots: ReadonlyArray<string>,
): Array<string> | null {
  if (!roots.some((root) => getModuleInfo(root))) {
    return null;
  }
  const styles: Array<string> = [];
  const seen = new Set<string>();
  const pending = [...roots].reverse();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (isLinkedStylesheet(id)) {
      // Another module cannot import a virtual (`\0`) id.
      if (!id.startsWith('\0')) {
        styles.push(id);
      }
      continue;
    }
    const imported = getModuleInfo(id)?.importedIds ?? [];
    for (let index = imported.length - 1; index >= 0; index--) {
      pending.push(imported[index]);
    }
  }
  return styles;
}

type IslandBuildContext = {
  environment?: { config: { consumer: string } };
  getModuleInfo(id: string): ModuleImports | null;
};

// Vite can reload the config file for each environment build, so the server
// and client builds may use separate plugin instances. Keep the result here.
const islandStylesByPagesDir = new Map<string, Array<string>>();

/**
 * Call from `buildEnd`. Island pages render only on the server, so the server
 * build has resolved their imports (aliases, packages, Vue and Svelte style
 * blocks) and the client build has not. Records the stylesheets of island pages
 * and their layouts for the islands client entry, which builds after it.
 */
export function recordIslandStyles(
  context: IslandBuildContext,
  pageScan: PageScanResult | null,
  pagesDir: string,
): void {
  if (!pageScan || context.environment?.config.consumer !== 'server') {
    return;
  }
  const styles = collectIslandStyles(
    (id) => context.getModuleInfo(id),
    islandStyleRoots(pageScan, pagesDir),
  );
  // Another server environment (an auxiliary Worker) does not have the pages.
  if (styles) {
    islandStylesByPagesDir.set(normalizePath(pagesDir), styles);
  }
}

/** The stylesheets that the server build recorded, or null without a server build. */
export function recordedIslandStyles(pagesDir: string): ReadonlyArray<string> | null {
  return islandStylesByPagesDir.get(normalizePath(pagesDir)) ?? null;
}

/**
 * Keeps the CSS modules (`*.module.css`, Vue `<style module>`) that the
 * islands client entry imports. Vite marks a CSS module as free of side
 * effects, so the entry's bare import would drop it and its rules.
 */
export function islandStylesPlugin(pagesDir: string): Plugin {
  return {
    name: 'void:islands-styles',
    apply: 'build',
    enforce: 'post',
    transform: {
      order: 'post',
      filter: { id: /\.module\./ },
      handler(code, id) {
        if (
          this.environment.config.consumer === 'client' &&
          recordedIslandStyles(pagesDir)?.includes(id)
        ) {
          return { code, map: null, moduleSideEffects: 'no-treeshake' };
        }
      },
    },
  };
}

/**
 * Rewrite a matched CSS import line so relative specifiers resolve from the
 * virtual module. Absolute and bare specifiers are kept as-is.
 */
export function rewriteCssImportForVirtualModule(
  matchedLine: string,
  specifier: string,
  sourceFilePath: string,
): string {
  if (specifier.startsWith('.')) {
    const absPath = normalizePath(resolve(dirname(sourceFilePath), specifier));
    return `import ${JSON.stringify(absPath)};`;
  }
  const statement = matchedLine.trim();
  return statement.endsWith(';') ? statement : statement + ';';
}

export type IslandClientEntryOptions = {
  manifest: IslandManifest;
  /** From `islandCssFiles`. */
  cssFiles: ReadonlySet<string>;
  /** From `recordedIslandStyles`. */
  styles: ReadonlyArray<string> | null;
  /** Whether a built page loads the entry for its islands. */
  needsRuntime: boolean;
  isDev: boolean;
  /** Imports for the style blocks of a Vue or Svelte component. */
  styleBlockImports?: (file: string, content: string) => Array<string>;
  /** Source that defines `async function hydrateIsland(el, mod, props, frontmatter)`. */
  hydrateIsland: string;
};

export function generateIslandClientEntry(options: IslandClientEntryOptions): string {
  const uniqueIslands = new Map<string, string>();
  for (const entry of options.manifest.entries.values()) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: Array<string> = [];

  // In dev, first-paint CSS is provided by Void's shared dev CSS collector.
  // Skip style imports here to avoid duplicate client injection.
  // In production, the imports below bundle the CSS that island pages link.
  // `styles` comes from the server build; without one, only the direct
  // imports and style blocks of the pages and layouts are known.
  if (!options.isDev && options.styles) {
    for (const id of options.styles) {
      lines.push(`import ${JSON.stringify(id)};`);
    }
  } else if (!options.isDev) {
    for (const file of options.cssFiles) {
      const content = readFileSync(file, 'utf-8');
      lines.push(...(options.styleBlockImports?.(file, content) ?? []));
      for (const item of findStaticCssImports(content, file)) {
        lines.push(rewriteCssImportForVirtualModule(item.statement, item.specifier, file));
      }
    }
  }

  // Without islands, no built page gets this script (see
  // computePagesNeedingClientJS), so the entry only gives the styles a chunk to
  // link. Dev keeps the runtime: it does not reload this module when a page
  // gains an island.
  if (!options.needsRuntime && !options.isDev) {
    return lines.join('\n');
  }

  lines.push('import { initIslands } from "void/pages-client";');
  lines.push('const islands = {');
  for (const [id, path] of uniqueIslands) {
    lines.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(path)}),`);
  }
  lines.push('};');
  lines.push(options.hydrateIsland);
  lines.push('initIslands(islands, hydrateIsland);');

  return lines.join('\n');
}

/** Extract CSS import statements from a file and return them as @import rules. */
export function extractCssImports(filePath: string): string {
  const code = readFileSync(filePath, 'utf-8');
  return findStaticCssImports(code, filePath)
    .map(({ specifier }) => `@import ${JSON.stringify(specifier)};`)
    .join('\n');
}

/** Compute which island pages need client-side JavaScript. */
export function computePagesNeedingClientJS(
  pageScan: PageScanResult,
  pagesDir: string,
  resolvedConfig: ResolvedConfig | null,
): Set<string> {
  const mdScriptIds = mdClientScriptIds(resolvedConfig);

  const layoutDirsWithIslands = new Set<string>();
  for (const layout of pageScan.layouts) {
    if (!layout.island) {
      continue;
    }
    const filePath = resolve(pagesDir, layout.filePath);
    const code = readFileSync(filePath, 'utf-8');
    if (hasIslandImports(code, filePath)) {
      layoutDirsWithIslands.add(layout.directory);
    }
  }

  const result = new Set<string>();
  for (const page of pageScan.pages) {
    if (!page.island) {
      continue;
    }

    if (mdScriptIds.has(page.componentId)) {
      result.add(page.componentId);
      continue;
    }

    const filePath = resolve(pagesDir, page.componentPath);
    const code = readFileSync(filePath, 'utf-8');
    if (hasIslandImports(code, filePath)) {
      result.add(page.componentId);
      continue;
    }

    const layoutChain = resolveEffectiveLayoutChain(page, pageScan.layouts, pageScan.namedLayouts);
    for (const layout of layoutChain) {
      if (layoutDirsWithIslands.has(layout.directory)) {
        result.add(page.componentId);
        break;
      }
    }
  }

  return result;
}

/**
 * Watch the pages directory for structural changes (add/remove) and .md content
 * changes (frontmatter layout field) so that new layouts and named layouts are
 * picked up without a dev server restart.
 *
 * Returns a `flush()` function that resolves when any pending rescan completes
 * (useful for tests).
 */
export function watchPagesForRescan(
  server: ViteDevServer,
  pagesDir: string,
  root: string,
  onRescan: (pageScan: PageScanResult) => void,
): { flush: () => Promise<void> } {
  let pending: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const normalizedPagesDir = normalizePath(pagesDir);

  const scheduleRescan = (path: string) => {
    const normalizedPath = normalizePath(path);
    if (
      normalizedPath !== normalizedPagesDir &&
      !normalizedPath.startsWith(normalizedPagesDir + '/')
    ) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Only the dev server watches pages, so keep the dev pages.
      pending = scanPages(root, { pagesDir, environment: 'dev' })
        .then(
          (pageScan) => {
            onRescan(pageScan);
            for (const env of Object.values(server.environments)) {
              const mod = env.moduleGraph.getModuleById('\0' + ISLANDS_RENDERER_ID);
              if (mod) {
                env.moduleGraph.invalidateModule(mod);
              }
            }
          },
          () => {
            // The adapter pages plugin runs the same scan on the same events and
            // logs its error. Keep the last good scan until the next change.
          },
        )
        .finally(() => {
          pending = null;
        });
    }, 50);
  };

  server.watcher.on('add', scheduleRescan);
  server.watcher.on('unlink', scheduleRescan);
  server.watcher.on('change', (path) => {
    if (normalizePath(path).endsWith('.md')) {
      scheduleRescan(path);
    }
  });

  return {
    flush: () => pending ?? Promise.resolve(),
  };
}

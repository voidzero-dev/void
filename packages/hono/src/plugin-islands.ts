import { existsSync } from 'node:fs';
import { dirname } from 'pathslash';
import type { Plugin, ResolvedConfig } from 'vite';
import { generateComponentManifest, scanPages } from 'void/pages';
import type { PageScanResult } from 'void/pages';
import {
  createIslandManifest,
  generateIslandClientEntry,
  islandCssFiles,
  islandsBuildConfig,
  mdClientScriptIds,
  recordIslandStyles,
  recordedIslandStyles,
  islandStylesPlugin,
  computePagesNeedingClientJS,
  watchPagesForRescan,
  ISLANDS_RENDERER_ID,
  ISLANDS_CLIENT_ENTRY_ID,
  findIslandImports,
  editIslandSource,
  type IslandSourceEdit,
} from 'void/pages-islands-plugin';

const COMPONENT_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

// Each mounted island registers how to render itself again, so that the dev
// client can replace a component that was edited. The build drops this
// together with the `import.meta.hot` branch.
const HYDRATE_ISLAND = `
async function hydrateIsland(el, mod, props, frontmatter) {
  const { jsx, useLayoutEffect } = await import("hono/jsx/dom");
  const { hydrateRoot } = await import("hono/jsx/dom/client");
  const FrontmatterContext =
    Object.keys(frontmatter).length > 0 ? (await import("@void/hono")).FrontmatterContext : null;
  function createIsland(Component) {
    const island = jsx(Component, props);
    const content = FrontmatterContext
      ? jsx(FrontmatterContext.Provider, { value: frontmatter }, island)
      : island;
    function HydratedIsland() {
      useLayoutEffect(() => {
        el.setAttribute("data-hydrated", "true");
      }, []);
      return content;
    }
    return jsx(HydratedIsland, {});
  }
  const root = hydrateRoot(el, createIsland(mod.default || mod));
  if (import.meta.hot) {
    const mounted = (globalThis.__voidHonoIslands ??= new Map());
    const id = el.getAttribute("data-island");
    if (!mounted.has(id)) mounted.set(id, new Set());
    mounted.get(id).add((next) => root.render(createIsland(next.default || next)));
  }
}`;

/**
 * Hono JSX has no Fast Refresh. In dev, an island component accepts its own
 * updates instead and renders each mounted island again with the new
 * component, which resets the island's state. Where the component is not
 * mounted as an island, the update goes on to its importers.
 */
function islandHmrCode(islandId: string): string {
  return `
if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    const mounted = globalThis.__voidHonoIslands?.get(${JSON.stringify(islandId)});
    if (!next || !mounted?.size) {
      import.meta.hot.invalidate();
      return;
    }
    for (const update of mounted) update(next);
  });
}
`;
}

export function islandsPlugin(
  pagesDir: string,
  options?: { root?: string },
): ReadonlyArray<Plugin> {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  const root = options?.root ?? dirname(pagesDir);
  const islandManifest = createIslandManifest(root, COMPONENT_EXTENSIONS);
  let cssFiles = new Set<string>();
  let resolvedConfig: ResolvedConfig | null = null;

  return [
    {
      name: 'void-hono:islands',

      configResolved(config) {
        resolvedConfig = config;
        isDev = config.command === 'serve';
      },

      configureServer(server) {
        watchPagesForRescan(server, pagesDir, root, (scan: PageScanResult) => {
          pageScan = scan;
        });
      },

      async buildStart() {
        if (existsSync(pagesDir)) {
          pageScan = await scanPages(root, {
            pagesDir,
            environment: isDev ? 'dev' : 'prod',
          });
          islandManifest.registerPages(pageScan, pagesDir);
          cssFiles = islandCssFiles(pageScan, pagesDir, /\.(tsx|jsx)$/);
        }
      },

      buildEnd() {
        recordIslandStyles(this, pageScan, pagesDir);
      },

      resolveId: {
        filter: { id: /^virtual:void-islands-(renderer|client)$/ },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return '\0' + source;
          }
        },
      },

      load: {
        // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
        filter: { id: /^\0virtual:void-islands-(renderer|client)$/ },
        handler(id) {
          if (id === '\0' + ISLANDS_RENDERER_ID) {
            if (!pageScan) {
              return "export function renderIslandPage() { throw new Error('No pages found'); }";
            }
            const mdScriptIds = mdClientScriptIds(resolvedConfig);
            const needsJS = computePagesNeedingClientJS(pageScan, pagesDir, resolvedConfig);
            return generateIslandRenderer(pageScan, pagesDir, isDev, mdScriptIds, needsJS);
          }
          if (id === '\0' + ISLANDS_CLIENT_ENTRY_ID) {
            if (!pageScan) {
              return '';
            }
            return generateIslandClientEntry({
              manifest: islandManifest,
              cssFiles,
              styles: recordedIslandStyles(pagesDir),
              needsRuntime:
                islandManifest.entries.size > 0 ||
                computePagesNeedingClientJS(pageScan, pagesDir, resolvedConfig).size > 0,
              isDev,
              hydrateIsland: HYDRATE_ISLAND,
            });
          }
        },
      },

      // Rewrite island imports inline — the workerd module runner resolves imports
      // from the pre-transform AST, so we can't rely on resolveId to intercept
      // rewritten specifiers. Instead, we replace each island import with:
      //   1. A renamed import of the raw component
      //   2. An inline wrapper that adds data-island/data-props/data-hydrate attributes
      // This also populates the islandManifest for the client entry.
      transform: {
        filter: { id: /\.island\.(tsx|jsx)$/ },
        handler(code, id) {
          if (/import\s+\{[^}]*\buseForm\b/.test(code)) {
            this.warn(
              `islands: useForm cannot be imported in island page '${id}'. Use useIslandForm instead.`,
            );
          }

          const importerDir = dirname(id);
          const edits: Array<IslandSourceEdit> = [];
          const wrappers: Array<string> = [];
          let idx = 0;

          for (const islandImport of findIslandImports(code, id)) {
            const name = islandImport.importName;
            const specRaw = islandImport.specifierRaw;
            const strategy = islandImport.hydrate;
            const spec = islandImport.specifier;
            const rawName = `_raw_island_${idx++}`;

            const { islandId } = islandManifest.register(spec, importerDir, strategy);

            const replacement = `import ${rawName} from ${specRaw}`;
            edits.push({ start: islandImport.start, end: islandImport.end, text: replacement });

            // Generate wrapper that adds data-island attributes during SSR.
            // Uses _jsx_island (imported below) to create the elements.
            wrappers.push(
              `var ${name} = function ${name}(props) {` +
                ` return _jsx_island("div", {` +
                ` "data-island": ${JSON.stringify(islandId)},` +
                ` "data-props": JSON.stringify(props),` +
                ` "data-hydrate": ${JSON.stringify(strategy)}` +
                ` }, _jsx_island(${rawName}, props));` +
                ` };`,
            );
          }

          if (wrappers.length > 0) {
            // Prepend a Hono JSX import for the wrapper functions
            return editIslandSource(code, edits, {
              prepend: 'import { jsx as _jsx_island } from "hono/jsx";\n',
              append: '\n' + wrappers.join('\n'),
            });
          }
        },
      },

      async config(_, env) {
        if (env.command !== 'serve') {
          return islandsBuildConfig(root, pagesDir);
        }
      },
    },
    {
      name: 'void-hono:islands-hmr',
      apply: 'serve',
      transform: {
        filter: { id: /\.(tsx|jsx|ts|js)$/ },
        handler(code, id) {
          if (this.environment.name !== 'client') {
            return;
          }
          for (const entry of islandManifest.entries.values()) {
            if (entry.componentPath === id) {
              return { code: code + islandHmrCode(entry.islandId), map: null };
            }
          }
        },
      },
    },
    islandStylesPlugin(pagesDir),
  ];
}

function generateIslandRenderer(
  scan: PageScanResult,
  pagesDir: string,
  isDev: boolean,
  mdScriptIds: Set<string>,
  pagesNeedingClientJS: Set<string>,
): string {
  return `
import { renderHonoIslandPage } from "@void/hono/pages-server";

${generateComponentManifest(scan, pagesDir)}
const __mdClientScriptIds = new Set(${JSON.stringify([...mdScriptIds])});
const __pagesNeedingClientJS = new Set(${JSON.stringify([...pagesNeedingClientJS])});

export async function renderIslandPage(pageObj, assetTags) {
  return renderHonoIslandPage({
    pageObj,
    assetTags,
    components,
    layoutTree,
    mdClientScriptIds: __mdClientScriptIds,
    pagesNeedingClientJS: __pagesNeedingClientJS,
    isDev: ${isDev},
  });
}
`;
}

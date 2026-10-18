import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'pathslash';
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite';
import { generateComponentManifest, scanPages, resolveEffectiveLayoutChain } from 'void/pages';
import type { PageScanResult } from 'void/pages';
import {
  resolveSpecifier,
  hasIslandPages,
  recordIslandStyles,
  recordedIslandStyles,
  islandStylesPlugin,
  rewriteCssImportForVirtualModule,
  computePagesNeedingClientJS,
  watchPagesForRescan,
  ISLANDS_RENDERER_ID,
  ISLANDS_CLIENT_ENTRY_ID,
  findIslandImports,
  findStaticCssImports,
  editIslandSource,
  type IslandSourceEdit,
} from 'void/pages-islands-plugin';
import type { IslandEntry } from 'void/pages-islands-plugin';

const COMPONENT_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];
/**
 * Prefix for virtual island wrapper modules. Must NOT use the `\0` prefix
 * because `vite-plugin-solid` skips `\0`-prefixed modules in its transform
 * filter. Uses a clean `.tsx` extension (no query params) so rolldown can
 * detect the language.
 */
const WRAPPER_PREFIX = '/@void-island-wrap/';

type WrapperMeta = {
  src: string;
  islandId: string;
  hydrate: string;
};
type MdPluginWithApi = Plugin & {
  api?: {
    getClientScripts?: () => Map<string, unknown>;
  };
};
type ScannableEntry = { filePath: string; island: boolean | undefined };

export function islandsPlugin(
  pagesDir: string,
  options?: { root?: string },
): ReadonlyArray<Plugin> {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  const root = options?.root ?? dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  const wrapperMeta = new Map<string, WrapperMeta>();
  let wrapperId = 0;
  let resolvedConfig: ResolvedConfig | null = null;

  /** Resolve an island import and record it in the client manifest. */
  function registerIsland(
    spec: string,
    importerDir: string,
    hydrate: string,
  ): { absPath: string | null; islandId: string } {
    const absPath = resolveSpecifier(spec, importerDir, COMPONENT_EXTENSIONS);
    if (!absPath) {
      return { absPath, islandId: spec };
    }
    const islandId = normalizePath(relative(root, absPath)).replace(/\.[^.]+$/, '');
    islandManifest.set(islandId, { componentPath: absPath, islandId, hydrate });
    return { absPath, islandId };
  }

  return [
    {
      name: 'void-solid:islands',
      enforce: 'pre',

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
          pageScan = await scanPages(root, { pagesDir });
          // Pre-scan island pages to populate the manifest eagerly.
          // This is needed because the client build may load the virtual
          // islands-client entry before island page transforms run.
          const filesToScan: ReadonlyArray<ScannableEntry> = [
            ...pageScan.pages.map((page) => ({
              filePath: page.componentPath,
              island: page.island,
            })),
            ...pageScan.layouts.map((layout) => ({
              filePath: layout.filePath,
              island: layout.island,
            })),
            ...pageScan.namedLayouts.map((namedLayout) => ({
              filePath: namedLayout.filePath,
              island: namedLayout.island,
            })),
          ];
          for (const entry of filesToScan) {
            if (!entry.island) {
              continue;
            }
            const filePath = resolve(pagesDir, entry.filePath);
            const code = readFileSync(filePath, 'utf-8');
            const importerDir = dirname(filePath);
            for (const islandImport of findIslandImports(code, filePath)) {
              registerIsland(islandImport.specifier, importerDir, islandImport.hydrate);
            }
          }

          // Collect page and layout files needing CSS for island pages
          for (const page of pageScan.pages) {
            if (!page.island) {
              continue;
            }
            if (/\.(tsx|jsx)$/.test(page.componentPath)) {
              islandCssFiles.add(normalizePath(resolve(pagesDir, page.componentPath)));
            }
            const layoutChain = resolveEffectiveLayoutChain(
              page,
              pageScan.layouts,
              pageScan.namedLayouts,
            );
            for (const layout of layoutChain) {
              islandCssFiles.add(normalizePath(resolve(pagesDir, layout.filePath)));
            }
          }
        }
      },

      buildEnd() {
        recordIslandStyles(this, pageScan, pagesDir);
      },

      resolveId: {
        filter: {
          id: /^(virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)/,
        },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return '\0' + source;
          }
          if (source.startsWith(WRAPPER_PREFIX)) {
            return source;
          }
        },
      },

      load: {
        filter: {
          // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
          id: /^(\0virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)/,
        },
        handler(id) {
          if (id === '\0' + ISLANDS_RENDERER_ID) {
            if (!pageScan) {
              return "export function renderIslandPage() { throw new Error('No pages found'); }";
            }
            const mdPlugin = resolvedConfig?.plugins?.find(
              (plugin): plugin is MdPluginWithApi => plugin.name === 'void-md',
            );
            const mdScriptIds: Set<string> = new Set(
              mdPlugin?.api?.getClientScripts?.()?.keys() ?? [],
            );
            const needsJS = computePagesNeedingClientJS(pageScan, pagesDir, resolvedConfig);
            return generateIslandRenderer(pageScan, pagesDir, mdScriptIds, needsJS);
          }
          if (id === '\0' + ISLANDS_CLIENT_ENTRY_ID) {
            if (!pageScan) {
              return '';
            }
            return generateIslandClientEntry(
              islandManifest,
              islandCssFiles,
              recordedIslandStyles(pagesDir),
              islandManifest.size > 0 ||
                computePagesNeedingClientJS(pageScan, pagesDir, resolvedConfig).size > 0,
              isDev,
            );
          }
          if (id.startsWith(WRAPPER_PREFIX)) {
            const meta = wrapperMeta.get(id);
            if (meta) {
              return generateWrapperComponent(meta);
            }
          }
        },
      },

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

          for (const islandImport of findIslandImports(code, id)) {
            const name = islandImport.importName;
            const spec = islandImport.specifier;
            const strategy = islandImport.hydrate;

            const { absPath, islandId } = registerIsland(spec, importerDir, strategy);

            const wrapperUrl = WRAPPER_PREFIX + 'island_' + wrapperId++ + '.tsx';
            wrapperMeta.set(wrapperUrl, { src: absPath || spec, islandId, hydrate: strategy });
            const replacement = `import ${name} from ${JSON.stringify(wrapperUrl)}`;
            edits.push({ start: islandImport.start, end: islandImport.end, text: replacement });
          }

          if (edits.length > 0) {
            return editIslandSource(code, edits);
          }
        },
      },

      async config(_, env) {
        if (env.command !== 'serve' && (await hasIslandPages(root, pagesDir))) {
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
      },
    },
    islandStylesPlugin(pagesDir),
  ];
}

function generateWrapperComponent(meta: WrapperMeta): string {
  return `import _Cmp from ${JSON.stringify(meta.src)};
export default function _IslandWrap(props) {
  return <div data-island="${meta.islandId}" data-props={JSON.stringify(props)} data-hydrate="${meta.hydrate}"><_Cmp {...props} /></div>;
}
`;
}

function generateIslandRenderer(
  scan: PageScanResult,
  pagesDir: string,
  mdScriptIds: Set<string>,
  pagesNeedingClientJS: Set<string>,
): string {
  const mdScriptIdsCode = `const __mdClientScriptIds = new Set(${JSON.stringify([...mdScriptIds])});`;
  const needsJSCode = `const __pagesNeedingClientJS = new Set(${JSON.stringify([...pagesNeedingClientJS])});`;

  return `
import { renderToStringAsync, generateHydrationScript } from "solid-js/web";
import { createComponent } from "solid-js";
import { SharedContext, ErrorsContext, ParamsContext, FrontmatterContext } from "@void/solid";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";
import { islandFrontmatterScript } from "void/pages-server";

${generateComponentManifest(scan, pagesDir)}
${mdScriptIdsCode}
${needsJSCode}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const __pageModule = await components[pageObj.component]();
  const PageComponent = __pageModule.default;
  const __frontmatter = __pageModule.frontmatter ?? {};
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  function ServerApp() {
    return createComponent(SharedContext.Provider, {
      value: pageObj.shared || {},
      get children() {
        return createComponent(ErrorsContext.Provider, {
          value: pageObj.errors || {},
          get children() {
            return createComponent(ParamsContext.Provider, {
              value: pageObj.params || {},
              get children() {
                // Frontmatter wraps the layouts so they can read the Markdown page's values.
                return createComponent(FrontmatterContext.Provider, {
                  value: __frontmatter,
                  get children() {
                    // Build layout chain inside providers so contexts are available.
                    // No RouterContext — islands have no Void Router.
                    let element = createComponent(PageComponent, pageObj.props);
                    for (let i = layoutComponents.length - 1; i >= 0; i--) {
                      const Layout = layoutComponents[i];
                      const child = element;
                      element = createComponent(Layout, { get children() { return child; } });
                    }
                    return element;
                  }
                });
              }
            });
          }
        });
      }
    });
  }

  const html = await renderToStringAsync(() => createComponent(ServerApp, {}));

  // Islands hydrate as separate roots. Send the page frontmatter so their
  // useFrontmatter() returns the same value in the browser.
  const __frontmatterScript = __pagesNeedingClientJS.has(pageObj.component) && html.includes("data-island=")
    ? islandFrontmatterScript(__pageModule.frontmatter)
    : "";
  const __mdScriptAttr = __mdClientScriptIds.has(pageObj.component) ? \` data-md-script="\${escapeAttr(pageObj.component)}"\` : "";
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}\${__pagesNeedingClientJS.has(pageObj.component) ? generateHydrationScript() : ""}</head>
<body\${bodyAttrs}>
  <div id="app"\${__mdScriptAttr}>\${html}</div>
  \${__frontmatterScript}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.body : ""}
</body>
</html>\`;
}
`;
}

function generateIslandClientEntry(
  manifest: Map<string, IslandEntry>,
  cssFiles: Set<string>,
  styles: ReadonlyArray<string> | null,
  needsRuntime: boolean,
  isDev: boolean,
): string {
  const entries = [...manifest.values()];
  const uniqueIslands = new Map<string, string>();
  for (const entry of entries) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: Array<string> = [];

  // In dev, first-paint CSS is provided by Void's shared dev CSS collector.
  // Skip CSS imports here to avoid duplicate client injection.
  // In production, the imports below bundle the CSS that island pages link.
  // `styles` comes from the server build; without one, only the direct
  // imports of the pages and layouts are known.
  if (!isDev && styles) {
    for (const id of styles) {
      lines.push(`import ${JSON.stringify(id)};`);
    }
  } else if (!isDev) {
    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const item of findStaticCssImports(content, file)) {
        lines.push(rewriteCssImportForVirtualModule(item.statement, item.specifier, file));
      }
    }
  }

  // Without islands, no built page gets this script (see
  // computePagesNeedingClientJS), so the entry only gives the styles a chunk to
  // link. Dev keeps the runtime: it does not reload this module when a page
  // gains an island.
  if (!needsRuntime && !isDev) {
    return lines.join('\n');
  }

  lines.push('import { initIslands } from "void/pages-client";');
  lines.push('const islands = {');
  for (const [id, path] of uniqueIslands) {
    lines.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(path)}),`);
  }
  lines.push('};');

  // Use render (not hydrate) for island activation. Solid's hydrate() uses
  // tree-position-dependent hydration keys that won't match when hydrating a
  // sub-component that was SSR'd deeper in the component tree (inside context
  // providers and layouts). render() replaces the server HTML with a fresh
  // client render — the brief re-render is acceptable for interactive islands.
  lines.push(`
async function mountIsland(el, mod, props, frontmatter) {
  const { render } = await import("solid-js/web");
  const { createComponent } = await import("solid-js");
  const Component = mod.default || mod;
  const { FrontmatterContext } =
    Object.keys(frontmatter).length > 0 ? await import("@void/solid") : {};
  el.textContent = "";
  render(
    () =>
      FrontmatterContext
        ? createComponent(FrontmatterContext.Provider, {
            value: frontmatter,
            get children() {
              return createComponent(Component, props);
            },
          })
        : createComponent(Component, props),
    el,
  );
  el.setAttribute("data-hydrated", "true");
}

initIslands(islands, mountIsland);
`);

  return lines.join('\n');
}

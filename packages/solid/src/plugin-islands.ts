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

// Each wrapper scopes its SSR keys independently of its page and layout.
// Recreate the same provider tree before hydrating that island's root. Every
// createComponent call opens a hydration context, so the provider stays even
// when the page has no frontmatter.
const HYDRATE_ISLAND = `
async function hydrateIsland(el, mod, props, frontmatter) {
  const { hydrate } = await import("solid-js/web");
  const { createComponent, sharedConfig } = await import("solid-js");
  const Component = mod.default || mod;
  const { FrontmatterContext } = await import("@void/solid");
  // Solid 1.x marks the document done on its first delegated event. A later
  // island is still an SSR root, even after another island was interacted with.
  globalThis._$HY.done = false;
  sharedConfig.done = false;
  hydrate(
    () => createComponent(FrontmatterContext.Provider, {
      value: frontmatter,
      get children() { return createComponent(Component, props); }
    }),
    el,
    { renderId: el.getAttribute("data-solid-render-id") },
  );
  el.setAttribute("data-hydrated", "true");
}`;
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

export function islandsPlugin(
  pagesDir: string,
  options?: { root?: string },
): ReadonlyArray<Plugin> {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  const root = options?.root ?? dirname(pagesDir);
  const islandManifest = createIslandManifest(root, COMPONENT_EXTENSIONS);
  let cssFiles = new Set<string>();
  const wrapperMeta = new Map<string, WrapperMeta>();
  let wrapperId = 0;
  let resolvedConfig: ResolvedConfig | null = null;

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
            const mdScriptIds = mdClientScriptIds(resolvedConfig);
            const needsJS = computePagesNeedingClientJS(pageScan, pagesDir, resolvedConfig);
            return generateIslandRenderer(pageScan, pagesDir, mdScriptIds, needsJS);
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

            const { absPath, islandId } = islandManifest.register(spec, importerDir, strategy);

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
        if (env.command !== 'serve') {
          return islandsBuildConfig(root, pagesDir);
        }
      },
    },
    islandStylesPlugin(pagesDir),
  ];
}

function generateWrapperComponent(meta: WrapperMeta): string {
  return `import _Cmp from ${JSON.stringify(meta.src)};
import { createComponent, createUniqueId, sharedConfig, useContext } from "solid-js";
import { FrontmatterContext } from "@void/solid";
export default function _IslandWrap(props) {
  const context = sharedConfig.context;
  const renderId = "void-" + createUniqueId() + "-";
  const frontmatter = useContext(FrontmatterContext);
  let content;
  // Keep the page's SSR serializer, suspense state and owner, but allocate
  // this island's keys from the same root used by the client hydrator.
  sharedConfig.context = { ...context, id: renderId, count: 0, noHydrate: false };
  try {
    content = createComponent(FrontmatterContext.Provider, {
      value: frontmatter,
      get children() { return createComponent(_Cmp, props); }
    });
  } finally {
    sharedConfig.context = context;
  }
  return <div data-island="${meta.islandId}" data-props={JSON.stringify(props)} data-hydrate="${meta.hydrate}" data-solid-render-id={renderId}>{content}</div>;
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

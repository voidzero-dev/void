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
import { REACT_REFRESH_PREAMBLE } from './plugin-pages.ts';

const COMPONENT_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

const HYDRATE_ISLAND = `
async function hydrateIsland(el, mod, props, frontmatter) {
  const { hydrateRoot } = await import("react-dom/client");
  const React = await import("react");
  const Component = mod.default || mod;
  let island = React.createElement(Component, props);
  if (Object.keys(frontmatter).length > 0) {
    const { FrontmatterContext } = await import("@void/react");
    island = React.createElement(FrontmatterContext.Provider, { value: frontmatter }, island);
  }
  function HydratedIsland() {
    React.useLayoutEffect(() => {
      el.setAttribute("data-hydrated", "true");
    }, []);
    return island;
  }
  hydrateRoot(el, React.createElement(HydratedIsland));
}`;

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
      name: 'void-react:islands',

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
            // Uses _React_island (imported below) for createElement.
            wrappers.push(
              `var ${name} = function ${name}(props) {` +
                ` return _React_island.createElement("div", {` +
                ` "data-island": ${JSON.stringify(islandId)},` +
                ` "data-props": JSON.stringify(props),` +
                ` "data-hydrate": ${JSON.stringify(strategy)}` +
                ` }, _React_island.createElement(${rawName}, props));` +
                ` };`,
            );
          }

          if (wrappers.length > 0) {
            // Prepend a React import for the wrapper functions
            return editIslandSource(code, edits, {
              prepend: 'import _React_island from "react";\n',
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
  const preambleScript = isDev ? REACT_REFRESH_PREAMBLE : '';

  const mdScriptIdsCode = `const __mdClientScriptIds = new Set(${JSON.stringify([...mdScriptIds])});`;
  const needsJSCode = `const __pagesNeedingClientJS = new Set(${JSON.stringify([...pagesNeedingClientJS])});`;

  return `
import React from "react";
import { renderToString } from "react-dom/server";
import { SharedContext, ErrorsContext, ParamsContext, FrontmatterContext } from "@void/react";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";
import { islandFrontmatterScript } from "void/pages-server";

${generateComponentManifest(scan, pagesDir)}
${mdScriptIdsCode}
${needsJSCode}

const PREAMBLE_SCRIPT = ${JSON.stringify(preambleScript)};

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

  let element = React.createElement(PageComponent, pageObj.props);
  for (let i = layoutComponents.length - 1; i >= 0; i--) {
    element = React.createElement(layoutComponents[i], null, element);
  }

  // No RouterContext — islands have no Void Router.
  // Frontmatter wraps the layouts so they can read the Markdown page's values.
  element = React.createElement(
    SharedContext.Provider,
    { value: pageObj.shared || {} },
    React.createElement(
      ParamsContext.Provider,
      { value: pageObj.params || {} },
      React.createElement(
        ErrorsContext.Provider,
        { value: pageObj.errors || {} },
        React.createElement(FrontmatterContext.Provider, { value: __frontmatter }, element)
      )
    )
  );

  const html = renderToString(element);
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
<head>\${headHtml}\${PREAMBLE_SCRIPT}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
<body\${bodyAttrs}>
  <div id="app"\${__mdScriptAttr}>\${html}</div>
  \${__frontmatterScript}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.body : ""}
</body>
</html>\`;
}
`;
}

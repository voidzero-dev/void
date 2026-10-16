import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'pathslash';
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite';
import { generateComponentManifest, scanPages, resolveEffectiveLayoutChain } from 'void/pages';
import type { PageScanResult } from 'void/pages';
import {
  resolveSpecifier,
  needsIslandClientBundle,
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

const COMPONENT_EXTENSIONS = ['.vue', '.tsx', '.jsx', '.ts', '.js'];
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
  const root = options?.root ?? dirname(pagesDir);
  const islandManifest = new Map<string, IslandEntry>();
  const islandCssFiles = new Set<string>();
  let isDev = false;
  let resolvedConfig: ResolvedConfig | null = null;

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
      name: 'void-vue:islands',
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

          for (const page of pageScan.pages) {
            if (!page.island) {
              continue;
            }
            if (page.componentPath.endsWith('.vue')) {
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
            return generateIslandClientEntry(islandManifest, islandCssFiles, isDev);
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
        filter: { id: /\.island\.vue$/ },
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

            const { islandId } = registerIsland(spec, importerDir, strategy);

            const replacement = `import ${rawName} from ${specRaw}`;
            edits.push({ start: islandImport.start, end: islandImport.end, text: replacement });

            wrappers.push(
              `const ${name} = {` +
                ` inheritAttrs: false,` +
                ` render() {` +
                ` const props = this.$attrs;` +
                ` return _h_island("div", {` +
                ` "data-island": ${JSON.stringify(islandId)},` +
                ` "data-props": JSON.stringify(props),` +
                ` "data-hydrate": ${JSON.stringify(strategy)}` +
                ` }, _h_island(${rawName}, props));` +
                ` }` +
                ` };`,
            );
          }

          if (wrappers.length > 0) {
            // Inject into <script setup> block — this transform runs with enforce: "pre"
            // so the Vue SFC compiler hasn't processed the file yet. We must place
            // the h() import and wrapper consts inside the script block.
            const scriptSetupRe = /<script\b[^>]*\bsetup\b[^>]*>/;
            const setupMatch = code.match(scriptSetupRe);
            if (!setupMatch) {
              throw new Error(`islands: Expected a <script setup> block in '${id}'.`);
            }
            const openEnd = setupMatch.index! + setupMatch[0].length;
            const closeIdx = code.indexOf('</script>', openEnd);
            if (closeIdx === -1) {
              throw new Error(`islands: Expected a closing </script> tag in '${id}'.`);
            }
            return editIslandSource(code, edits, {
              insert: [
                { offset: openEnd, text: '\nimport { h as _h_island } from "vue";' },
                { offset: closeIdx, text: '\n' + wrappers.join('\n') + '\n' },
              ],
            });
          }
        },
      },

      config(_, env) {
        if (!existsSync(pagesDir)) {
          return;
        }
        if (env.command === 'serve') {
          return { optimizeDeps: { include: ['vue'] } };
        }
        if (needsIslandClientBundle(pagesDir, /\.island\.vue$/, true)) {
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
  ];
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
import { createSSRApp, h, reactive, provide } from "vue";
import { renderToString } from "vue/server-renderer";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";

${generateComponentManifest(scan, pagesDir)}
${mdScriptIdsCode}
${needsJSCode}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const __pageModule = await components[pageObj.component]();
  const PageComponent = __pageModule.default;
  const __frontmatter = __pageModule.frontmatter;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const app = createSSRApp({
    setup() {
      provide("__void_shared", reactive(pageObj.shared || {}));
      provide("__void_params", reactive(pageObj.params || {}));
      if (__frontmatter) provide("__void_frontmatter", __frontmatter);
      // No router provided — islands have no Void Router
      return () => {
        let vnode = h(PageComponent, pageObj.props);
        for (let i = layoutComponents.length - 1; i >= 0; i--) {
          const inner = vnode;
          vnode = h(layoutComponents[i], null, { default: () => inner });
        }
        return vnode;
      };
    }
  });

  // \`Image\` collects its <link rel="preload" as="image"> tags in the SSR context.
  const ssrContext = {};
  const html = await renderToString(app, ssrContext);
  const imagePreloads = ssrContext.__voidImagePreloads ? ssrContext.__voidImagePreloads.render() : "";
  const __mdScriptAttr = __mdClientScriptIds.has(pageObj.component) ? \` data-md-script="\${escapeAttr(pageObj.component)}"\` : "";
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${imagePreloads}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
<body\${bodyAttrs}>
  <div id="app"\${__mdScriptAttr}>\${html}</div>
  \${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.body : ""}
</body>
</html>\`;
}
`;
}

function generateIslandClientEntry(
  manifest: Map<string, IslandEntry>,
  cssFiles: Set<string>,
  isDev: boolean,
): string {
  const entries = [...manifest.values()];
  const uniqueIslands = new Map<string, string>();
  for (const entry of entries) {
    uniqueIslands.set(entry.islandId, entry.componentPath);
  }

  const lines: Array<string> = [];

  lines.push('import { initIslands } from "void/pages-client";');

  // In dev, first-paint CSS is provided by Void's shared dev CSS collector.
  // Skip style imports here to avoid duplicate client injection.
  // In production, the <link> tags aren't used — the style imports below
  // ensure the CSS is included in the bundled output.
  if (!isDev) {
    const styleRe = /<style\b([^>]*)>/g;
    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf-8');
      styleRe.lastIndex = 0;
      let index = 0;
      let match;
      while ((match = styleRe.exec(content)) !== null) {
        const attrs = match[1];
        const scoped = /\bscoped\b/.test(attrs);
        const langMatch = attrs.match(/\blang\s*=\s*["'](\w+)["']/);
        const lang = langMatch ? langMatch[1] : 'css';
        let query = `?vue&type=style&index=${index}&lang.${lang}`;
        if (scoped) {
          query += '&scoped=true';
        }
        lines.push(`import ${JSON.stringify(file + query)};`);
        index++;
      }
      // Extract JS-style CSS imports (e.g. import "@void/md/theme.css")
      for (const item of findStaticCssImports(content, file)) {
        lines.push(rewriteCssImportForVirtualModule(item.statement, item.specifier, file));
      }
    }
  }

  lines.push('const islands = {');
  for (const [id, path] of uniqueIslands) {
    lines.push(`  ${JSON.stringify(id)}: () => import(${JSON.stringify(path)}),`);
  }
  lines.push('};');

  lines.push(`
async function hydrateIsland(el, mod, props) {
  const { createSSRApp, h } = await import("vue");
  const Component = mod.default || mod;
  const app = createSSRApp({ render: () => h(Component, props) });
  app.mount(el);
  el.setAttribute("data-hydrated", "true");
}

initIslands(islands, hydrateIsland);
`);

  return lines.join('\n');
}

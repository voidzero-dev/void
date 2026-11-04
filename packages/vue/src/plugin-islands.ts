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

const COMPONENT_EXTENSIONS = ['.vue', '.tsx', '.jsx', '.ts', '.js'];

const HYDRATE_ISLAND = `
async function hydrateIsland(el, mod, props, frontmatter) {
  const { createSSRApp, h } = await import("vue");
  const Component = mod.default || mod;
  const app = createSSRApp({ render: () => h(Component, props) });
  app.provide("__void_frontmatter", frontmatter);
  app.mount(el);
  el.setAttribute("data-hydrated", "true");
}`;

/** Imports for the `<style>` blocks of a Vue component. */
function styleBlockImports(file: string, content: string): Array<string> {
  const imports: Array<string> = [];
  let index = 0;
  for (const match of content.matchAll(/<style\b([^>]*)>/g)) {
    const attrs = match[1];
    const lang = attrs.match(/\blang\s*=\s*["'](\w+)["']/)?.[1] ?? 'css';
    let query = `?vue&type=style&index=${index}&lang.${lang}`;
    if (/\bscoped\b/.test(attrs)) {
      query += '&scoped=true';
    }
    imports.push(`import ${JSON.stringify(file + query)};`);
    index++;
  }
  return imports;
}

export function islandsPlugin(
  pagesDir: string,
  options?: { root?: string },
): ReadonlyArray<Plugin> {
  let pageScan: PageScanResult | null = null;
  const root = options?.root ?? dirname(pagesDir);
  const islandManifest = createIslandManifest(root, COMPONENT_EXTENSIONS);
  let cssFiles = new Set<string>();
  let isDev = false;
  let resolvedConfig: ResolvedConfig | null = null;

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
          pageScan = await scanPages(root, {
            pagesDir,
            environment: isDev ? 'dev' : 'prod',
          });
          islandManifest.registerPages(pageScan, pagesDir);
          cssFiles = islandCssFiles(pageScan, pagesDir, /\.vue$/);
        }
      },

      buildEnd() {
        recordIslandStyles(this, pageScan, pagesDir);
        if (this.environment.config.consumer !== 'client') {
          return;
        }
        // Vite drops a scoped style block when its component is not in the
        // bundle (`cssScopeTo`). Island pages and layouts render only on the
        // server, so keep the styles that the islands client entry imports.
        for (const id of recordedIslandStyles(pagesDir) ?? []) {
          const vite = this.getModuleInfo(id)?.meta.vite as { cssScopeTo?: unknown } | undefined;
          if (vite?.cssScopeTo) {
            delete vite.cssScopeTo;
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
              styleBlockImports,
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

            const { islandId } = islandManifest.register(spec, importerDir, strategy);

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

      async config(_, env) {
        if (!existsSync(pagesDir)) {
          return;
        }
        if (env.command === 'serve') {
          return { optimizeDeps: { include: ['vue'] } };
        }
        return islandsBuildConfig(root, pagesDir);
      },
    },
    islandStylesPlugin(pagesDir),
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

  const html = await renderToString(app);
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
<head>\${headHtml}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
<body\${bodyAttrs}>
  <div id="app"\${__mdScriptAttr}>\${html}</div>
  \${__frontmatterScript}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.body : ""}
</body>
</html>\`;
}
`;
}

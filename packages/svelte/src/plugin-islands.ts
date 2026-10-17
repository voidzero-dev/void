import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'pathslash';
import { preprocess, type CompileResult, type PreprocessorGroup } from 'svelte/compiler';
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
import { IMAGE_PRELOADS_KEY } from './runtime/image-preloads.ts';

const COMPONENT_EXTENSIONS = ['.svelte', '.ts', '.js'];
/**
 * Prefix for virtual island wrapper modules. Must NOT use the `\0` prefix
 * because `@sveltejs/vite-plugin-svelte` skips `\0`-prefixed modules in
 * its transform filter.
 */
const WRAPPER_PREFIX = '/@void-island-wrap/';
type MdPluginWithApi = Plugin & {
  api?: {
    getClientScripts?: () => Map<string, unknown>;
  };
};
type ScannableEntry = { filePath: string; island: boolean | undefined };
/** The shared API of vite-plugin-svelte, set on its `vite-plugin-svelte:config` plugin. */
type SveltePluginApi = {
  options: { preprocess?: PreprocessorGroup | Array<PreprocessorGroup> };
  idParser: (id: string, ssr: boolean) => unknown;
  compileSvelte: (
    request: unknown,
    code: string,
    options: unknown,
    environment: unknown,
    sourcemap?: unknown,
  ) => Promise<{ compiled: CompileResult }>;
};
type SvelteConfigPlugin = Plugin & { api?: SveltePluginApi };

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
      name: 'void-svelte:islands',
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
            if (page.componentPath.endsWith('.svelte')) {
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
        filter: {
          id: /^(virtual:void-islands-(renderer|client)|\/@void-island-wrap\/)/,
        },
        handler(source) {
          if (source === ISLANDS_RENDERER_ID || source === ISLANDS_CLIENT_ENTRY_ID) {
            return '\0' + source;
          }
          // Virtual wrapper modules — resolve without \0 prefix so the
          // Svelte vite plugin processes them as .svelte files
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
            return generateIslandClientEntry(islandManifest, islandCssFiles, isDev);
          }
          if (id.startsWith(WRAPPER_PREFIX)) {
            return generateWrapperComponent(id);
          }
        },
      },

      // Rewrite island imports to point to virtual wrapper components.
      // The wrapper module is a generated .svelte file that the Svelte
      // vite plugin compiles normally, wrapping the original component
      // with data-island/data-props/data-hydrate attributes.
      transform: {
        filter: { id: /\.island\.svelte$/ },
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

            const wrapperUrl =
              WRAPPER_PREFIX +
              encodeURIComponent(islandId) +
              '.svelte?src=' +
              encodeURIComponent(absPath || spec) +
              '&island=' +
              encodeURIComponent(islandId) +
              '&hydrate=' +
              encodeURIComponent(strategy);
            const replacement = `import ${name} from ${JSON.stringify(wrapperUrl)}`;
            edits.push({ start: islandImport.start, end: islandImport.end, text: replacement });
          }

          if (edits.length > 0) {
            return editIslandSource(code, edits);
          }
        },
      },

      config(_, env) {
        if (!existsSync(pagesDir)) {
          return;
        }
        if (env.command === 'serve') {
          return { optimizeDeps: { include: ['svelte'] } };
        }
        if (needsIslandClientBundle(pagesDir, /\.island\.svelte$/, true)) {
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
    {
      name: 'void-svelte:islands-style',
      // Only the build's client entry imports `<file>.svelte.css?island-style`
      // (dev CSS comes from Void's dev CSS collector).
      // - The id stays next to the component, so CSS url() resolves as in the
      //   component, and it misses vite-plugin-svelte's `.svelte?` filter.
      // - The CSS comes from vite-plugin-svelte's own preprocess options and
      //   compile, so the scope hashes match the SSR markup.
      // - The component is compiled here, not loaded with `this.load`: island
      //   pages and layouts render only on the server, and loading them would
      //   resolve their server-only imports in the client build.
      // - vite-plugin-svelte's `?svelte&type=style` id is not used: it only
      //   reads CSS already cached on the module, and its cssScopeTo drops the
      //   CSS when the component is not imported by the client build.
      apply: 'build',

      resolveId: {
        filter: { id: /\.svelte\.css\?island-style$/ },
        handler(source) {
          return source;
        },
      },

      load: {
        filter: { id: /\.svelte\.css\?island-style$/ },
        async handler(id) {
          const file = id.slice(0, -'.css?island-style'.length);
          const api = resolvedConfig?.plugins.find(
            (plugin): plugin is SvelteConfigPlugin => plugin.name === 'vite-plugin-svelte:config',
          )?.api;
          if (typeof api?.compileSvelte !== 'function' || typeof api.idParser !== 'function') {
            this.error(
              'Svelte island page styles need the @sveltejs/vite-plugin-svelte version that @void/svelte depends on.',
            );
          }
          this.addWatchFile(file);
          let code = readFileSync(file, 'utf-8');
          let map: unknown;
          if (api.options.preprocess) {
            const processed = await preprocess(code, api.options.preprocess, { filename: file });
            code = processed.code;
            map = processed.map;
            // This compile is outside the module graph, so `vite build --watch`
            // only sees files the preprocessor read (Sass partials) if listed.
            for (const dependency of processed.dependencies ?? []) {
              this.addWatchFile(dependency);
            }
          }
          const { compiled } = await api.compileSvelte(
            api.idParser(file, false),
            code,
            api.options,
            this.environment,
            map,
          );
          return { code: compiled.css?.code ?? '', map: compiled.css?.map ?? null };
        },
      },
    },
  ];
}

function generateWrapperComponent(id: string): string {
  const url = new URL(id, 'file://');
  const src = decodeURIComponent(url.searchParams.get('src') || '');
  const islandId = decodeURIComponent(url.searchParams.get('island') || '');
  const hydrate = decodeURIComponent(url.searchParams.get('hydrate') || 'load');

  // Each island hydrates on its own, so it keeps its own image preload links
  // (see `hydrateIsland`).
  return `<script>
  import { setContext } from "svelte";
  import Cmp from ${JSON.stringify(src)};
  let props = $props();
  setContext(${JSON.stringify(IMAGE_PRELOADS_KEY)}, new Map());
</script>
<div data-island="${islandId}" data-props={JSON.stringify(props)} data-hydrate="${hydrate}">
  <Cmp {...props} />
</div>
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
import { render } from "svelte/server";
import App from "@void/svelte/App.svelte";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";

${generateComponentManifest(scan, pagesDir)}
${mdScriptIdsCode}
${needsJSCode}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function renderIslandPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const { html, head } = render(App, {
    props: {
      page: PageComponent,
      layouts: layoutComponents,
      pageProps: pageObj.props,
      shared: pageObj.shared || {},
      params: pageObj.params || {},
      router: null,
      stores: null,
    },
  });

  const __mdScriptAttr = __mdClientScriptIds.has(pageObj.component) ? \` data-md-script="\${escapeAttr(pageObj.component)}"\` : "";
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${head}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
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
  // Skip CSS imports here to avoid duplicate client injection.
  // In production, the <link> tags aren't used — the imports below ensure
  // the CSS is included in the bundled output.
  if (!isDev) {
    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf-8');

      // A Svelte component has at most one top-level <style>.
      if (/<style\b/.test(content)) {
        lines.push(`import ${JSON.stringify(file + '.css?island-style')};`);
      }

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
  const { hydrate } = await import("svelte");
  const Component = mod.default || mod;
  // A fresh image preload context, as the island's server wrapper provides.
  const context = new Map([[${JSON.stringify(IMAGE_PRELOADS_KEY)}, new Map()]]);
  hydrate(Component, { target: el, props, context });
  el.setAttribute("data-hydrated", "true");
}

initIslands(islands, hydrateIsland);
`);

  return lines.join('\n');
}

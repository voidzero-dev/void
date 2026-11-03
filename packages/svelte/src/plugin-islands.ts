import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'pathslash';
import { preprocess, type CompileResult, type PreprocessorGroup } from 'svelte/compiler';
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

const COMPONENT_EXTENSIONS = ['.svelte', '.ts', '.js'];

const HYDRATE_ISLAND = `
async function hydrateIsland(el, mod, props, frontmatter) {
  const { hydrate } = await import("svelte");
  const Component = mod.default || mod;
  const context = new Map([["__void_frontmatter", frontmatter]]);
  hydrate(Component, { target: el, props, context });
  el.setAttribute("data-hydrated", "true");
}`;

/** A Svelte component has at most one top-level `<style>`. */
function styleBlockImports(file: string, content: string): Array<string> {
  return /<style\b/.test(content) ? [`import ${JSON.stringify(file + '.css?island-style')};`] : [];
}
/**
 * Prefix for virtual island wrapper modules. Must NOT use the `\0` prefix
 * because `@sveltejs/vite-plugin-svelte` skips `\0`-prefixed modules in
 * its transform filter.
 */
const WRAPPER_PREFIX = '/@void-island-wrap/';
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
  const islandManifest = createIslandManifest(root, COMPONENT_EXTENSIONS);
  let cssFiles = new Set<string>();
  let isDev = false;
  let resolvedConfig: ResolvedConfig | null = null;

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
          pageScan = await scanPages(root, {
            pagesDir,
            environment: isDev ? 'dev' : 'prod',
          });
          islandManifest.registerPages(pageScan, pagesDir);
          cssFiles = islandCssFiles(pageScan, pagesDir, /\.svelte$/);
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

            const { absPath, islandId } = islandManifest.register(spec, importerDir, strategy);

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

      async config(_, env) {
        if (!existsSync(pagesDir)) {
          return;
        }
        if (env.command === 'serve') {
          return { optimizeDeps: { include: ['svelte'] } };
        }
        return islandsBuildConfig(root, pagesDir);
      },
    },
    {
      name: 'void-svelte:islands-style',
      // Loads the component styles that the build's client entry imports (dev
      // CSS comes from Void's dev CSS collector): vite-plugin-svelte's
      // `<file>.svelte?svelte&type=style` ids that the server build recorded,
      // or `<file>.svelte.css?island-style` without a server build.
      // - The CSS comes from vite-plugin-svelte's own preprocess options and
      //   compile, so the scope hashes match the SSR markup.
      // - The component is compiled here, not loaded with `this.load`: island
      //   pages, their layouts and the components they import render only on
      //   the server, and loading them would resolve their server-only imports
      //   in the client build.
      // - vite-plugin-svelte's own load only reads CSS already cached on the
      //   compiled component, and its cssScopeTo drops the CSS when the client
      //   build does not import the component. Loading its id here keeps one
      //   module, so a component that the client build also imports does not
      //   bring the same rules twice.
      apply: 'build',

      resolveId: {
        filter: { id: /\.svelte\.css\?island-style$/ },
        handler(source) {
          return source;
        },
      },

      load: {
        filter: { id: [/\.svelte\.css\?island-style$/, /\.svelte\?svelte&type=style/] },
        order: 'pre',
        async handler(id) {
          const islandStyle = id.endsWith('.css?island-style');
          if (
            !islandStyle &&
            (this.environment.config.consumer !== 'client' ||
              !recordedIslandStyles(pagesDir)?.includes(id))
          ) {
            return;
          }
          const file = islandStyle
            ? id.slice(0, -'.css?island-style'.length)
            : id.slice(0, id.indexOf('?'));
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
    islandStylesPlugin(pagesDir),
  ];
}

function generateWrapperComponent(id: string): string {
  const url = new URL(id, 'file://');
  const src = decodeURIComponent(url.searchParams.get('src') || '');
  const islandId = decodeURIComponent(url.searchParams.get('island') || '');
  const hydrate = decodeURIComponent(url.searchParams.get('hydrate') || 'load');

  return `<script>
  import Cmp from ${JSON.stringify(src)};
  let props = $props();
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
      // Set above the layouts so they can read the Markdown page's values.
      frontmatter: __pageModule.frontmatter,
      router: null,
      stores: null,
    },
  });

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
<head>\${headHtml}\${head}\${assetTags.css}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.preloads : ""}</head>
<body\${bodyAttrs}>
  <div id="app"\${__mdScriptAttr}>\${html}</div>
  \${__frontmatterScript}\${__pagesNeedingClientJS.has(pageObj.component) ? assetTags.body : ""}
</body>
</html>\`;
}
`;
}

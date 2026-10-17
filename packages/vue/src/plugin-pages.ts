import { existsSync, readdirSync } from 'node:fs';
import { dirname } from 'pathslash';
import { normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import {
  generateComponentManifest,
  resolveStaticPageDataBuildOptions,
  scanPages,
} from 'void/pages';
import type { PageScanResult, StaticPageDataBuildOptions } from 'void/pages';

const RENDERER_ID = 'virtual:void-pages-renderer';
const CLIENT_ENTRY_ID = 'virtual:void-pages-client';

export type PrefetchConfig = {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
};

type PagesPluginOptions = {
  root?: string;
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
};

function isVuePageFile(id: string, pagesDir: string): boolean {
  if (!id.startsWith(pagesDir + '/')) {
    return false;
  }
  const rel = id.slice(pagesDir.length + 1);
  if (rel.split('/').some((s) => s.startsWith('_'))) {
    return false;
  }
  const basename = rel.slice(rel.lastIndexOf('/') + 1);
  return basename !== 'layout.vue' && !basename.endsWith('.island.vue');
}

function stripDefinePropsTypeArgument(code: string): string | null {
  // Find defineProps<...>( and strip the generic using bracket counting
  // to handle nested generics like InferProps<typeof loader>
  const match = /\bdefineProps\s*</.exec(code);
  if (!match) {
    return null;
  }

  const start = match.index + match[0].length - 1; // position of '<'
  let depth = 0;
  let end = -1;
  let newlineCount = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n') {
      newlineCount++;
    } else if (ch === '<') {
      depth++;
    } else if (ch === '>') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }

  return code.slice(0, start) + '\n'.repeat(newlineCount) + code.slice(end + 1);
}

/** Check if the pages directory has any non-island Vue page files. */
function hasNonIslandPages(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name;
      if (name.startsWith('_') || name.startsWith('layout.')) {
        continue;
      }
      if (name.endsWith('.vue') && !name.includes('.island.')) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): ReadonlyArray<Plugin> {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  let viteConfig: ResolvedConfig | undefined;
  const root = options?.root ?? dirname(pagesDir);
  const normalizedPagesDir = normalizePath(pagesDir);
  let pendingRescan: Promise<void> | null = null;
  const rescanPages = async () => {
    pageScan = existsSync(pagesDir) ? await scanPages(root, { pagesDir }) : null;
  };
  const runRescan = () => {
    pendingRescan ??= rescanPages().finally(() => {
      pendingRescan = null;
    });
    return pendingRescan;
  };

  const invalidatePageModules = (server: ViteDevServer) => {
    for (const env of Object.values(server.environments)) {
      for (const id of ['\0' + RENDERER_ID, '\0' + CLIENT_ENTRY_ID]) {
        const mod = env.moduleGraph.getModuleById(id);
        if (mod) {
          env.moduleGraph.invalidateModule(mod);
        }
      }
    }
  };

  return [
    {
      name: 'void-vue:pages-transform',
      enforce: 'pre',

      transform: {
        filter: { id: /\.vue$/ },
        handler(code, id) {
          if (!isVuePageFile(id, pagesDir)) {
            return;
          }
          const transformed = stripDefinePropsTypeArgument(code);
          if (!transformed) {
            return;
          }
          return { code: transformed, map: { mappings: '' } };
        },
      },

      handleHotUpdate: {
        order: 'pre',
        handler(ctx) {
          if (!isVuePageFile(ctx.file, pagesDir)) {
            return;
          }

          const read = ctx.read;
          // Vue reparses raw SFC source during HMR, so apply the same rewrite here.
          ctx.read = async () => {
            const code = await read();
            return stripDefinePropsTypeArgument(code) ?? code;
          };
        },
      },
    },
    {
      name: 'void-vue:pages',

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
        // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
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
            return generateRendererModule(pageScan, pagesDir);
          }
          if (id === '\0' + CLIENT_ENTRY_ID) {
            if (!pageScan) {
              return '';
            }
            return generateClientEntry(
              pageScan,
              pagesDir,
              options?.viewTransitions,
              options?.prefetch,
              resolveStaticPageDataBuildOptions(root, { publicDir: viteConfig?.publicDir }),
            );
          }
        },
      },

      configureServer(server) {
        const handlePagesChange = async (path: string, event: 'add' | 'change' | 'unlink') => {
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
          await runRescan();
          invalidatePageModules(server);
        };

        server.watcher.on('add', (path) => handlePagesChange(path, 'add'));
        server.watcher.on('change', (path) => handlePagesChange(path, 'change'));
        server.watcher.on('unlink', (path) => handlePagesChange(path, 'unlink'));
      },

      configResolved(config) {
        viteConfig = config;
      },

      config(_, env) {
        if (!existsSync(pagesDir)) {
          return;
        }

        if (env.command === 'serve') {
          isDev = true;
          return {
            optimizeDeps: {
              // Pre-include Vue so it's not discovered late via dynamic
              // imports during SPA navigation, avoiding a full-page reload
              // from Vite's dep optimizer.
              include: ['vue'],
            },
          };
        }

        // Skip the pages-client bundle when all pages are island pages
        if (!hasNonIslandPages(pagesDir)) {
          return;
        }

        return {
          environments: {
            client: {
              build: {
                manifest: true,
                rollupOptions: {
                  input: { 'pages-client': CLIENT_ENTRY_ID },
                },
              },
            },
          },
        };
      },
    },
  ];
}

function generateRendererModule(scan: PageScanResult, pagesDir: string): string {
  return `
import { createSSRApp, h, reactive, provide } from "vue";
import { renderToString } from "vue/server-renderer";
import { createSsrRouter, idleNavigationState } from "void/pages-client";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";
import { serializePageData } from "void/pages-server";

${generateComponentManifest(scan, pagesDir)}

function patchProps(comp, props) {
  if (comp.__voidPatched) return;
  comp.props = Object.keys(props);
  comp.__voidPatched = true;
}

export async function renderPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const app = createSSRApp({
    setup() {
      provide("__void_shared", reactive(pageObj.shared || {}));
      provide("__void_params", reactive(pageObj.params || {}));
      provide("__void_router", createSsrRouter(pageObj.url || "/", pageObj.params || {}));
      provide("__void_navigation", idleNavigationState());
      return () => {
        patchProps(PageComponent, pageObj.props);
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
  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${imagePreloads}\${assetTags.css}\${assetTags.preloads}</head>
<body\${bodyAttrs}>
  <script id="__VOID_PAGE_DATA__" type="application/json">\${pageData}</script>
  <div id="app">\${html}</div>
  \${assetTags.body}
</body>
</html>\`;
}
`;
}

function generateClientEntry(
  scan: PageScanResult,
  pagesDir: string,
  viewTransitions?: boolean,
  prefetch?: PrefetchConfig,
  staticPageData?: StaticPageDataBuildOptions,
): string {
  return `
import { createApp, createSSRApp, h, reactive, provide, shallowRef, nextTick, ref } from "vue";
import { createDeferred, resolveDeferred, rejectDeferred } from "@void/vue/deferred";
import { setActionRouter } from "@void/vue";
import { createRouterFacade, createVoidRouter, idleNavigationState } from "void/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

const shared = reactive({});
const params = reactive({});
const currentComponent = shallowRef(null);
const currentLayouts = shallowRef([]);
const currentProps = shallowRef({});
const currentPageKey = ref(0);
const routeUrl = ref(window.location.pathname + window.location.search + window.location.hash);
const navigation = reactive(idleNavigationState());

function patchProps(comp, props) {
  if (comp.__voidPatched) return;
  comp.props = Object.keys(props);
  comp.__voidPatched = true;
}

function replaceRecord(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source || {});
}

const { router, initialPageData, initialComponent, initialLayouts, start, commitInitialRender } =
  await createVoidRouter({
    adapter: {
      createDeferred: () => createDeferred(),
      resolveDeferred(ref, value) { resolveDeferred(ref, value); return ref; },
      rejectDeferred(ref, error) { rejectDeferred(ref, error); return ref; },
      isLoading: (ref) => ref.loading,
      applyUpdate(pageData, comp, layouts, options) {
        if (!options?.preserveState) currentPageKey.value++;
        replaceRecord(shared, pageData.shared || {});
        replaceRecord(params, pageData.params || {});
        currentProps.value = pageData.props;
        currentLayouts.value = layouts;
        currentComponent.value = comp;
        return nextTick();
      },
    },
    components, layoutTree, routeMeta, matchRoute,
    staticPageData: ${!!staticPageData?.enabled},
    staticPageDataFastPath: ${!!staticPageData?.fastPath},
    viewTransitions: ${!!viewTransitions},
    prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
    prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
    onRouteChange(url) {
      routeUrl.value = url;
    },
    onNavigationChange(next) {
      navigation.state = next.state;
      navigation.location = next.location;
      navigation.method = next.method;
    },
  });

const reactiveRouter = createRouterFacade(router, () => routeUrl.value, () => params);

setActionRouter(reactiveRouter);

Object.assign(shared, initialPageData.shared || {});
replaceRecord(params, initialPageData.params || {});
currentProps.value = initialPageData.props;
currentComponent.value = initialComponent;
currentLayouts.value = initialLayouts;

const appEl = document.getElementById("app");
if (!appEl) throw new Error("pages: Missing #app element for Void Vue pages hydration.");
const createVoidApp = appEl.getAttribute("data-void-ssr") === "false" ? createApp : createSSRApp;
const app = createVoidApp({
  setup() {
    provide("__void_shared", shared);
    provide("__void_params", params);
    provide("__void_router", reactiveRouter);
    provide("__void_navigation", navigation);

    return () => {
      if (!currentComponent.value) return null;
      patchProps(currentComponent.value, currentProps.value);
      let vnode = h(currentComponent.value, { ...currentProps.value, key: currentPageKey.value });
      for (let i = currentLayouts.value.length - 1; i >= 0; i--) {
        const inner = vnode;
        vnode = h(currentLayouts.value[i], null, { default: () => inner });
      }
      return vnode;
    };
  }
});

app.mount(appEl);
appEl.setAttribute("data-hydrated", "true");
export { reactiveRouter as router };
start();
commitInitialRender();
`;
}

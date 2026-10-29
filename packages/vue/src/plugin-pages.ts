import { readdirSync } from 'node:fs';
import { normalizePath, type Plugin } from 'vite';
import { createPagesPlugin, generateComponentManifest } from 'void/pages';
import type { PageScanResult, StaticPageDataBuildOptions } from 'void/pages';

const CLIENT_ENTRY_ID = 'virtual:void-pages-client';

/** Runtime helper injected into generated SSR and client page bundles. */
const PATCH_PROPS_RUNTIME = `
function hasRuntimePropsDeclaration(comp) {
  const declared = comp.props;
  if (declared == null) return false;
  if (Array.isArray(declared)) return declared.length > 0;
  if (typeof declared === "object") return Object.keys(declared).length > 0;
  return false;
}

function patchProps(comp, props) {
  if (comp.__voidPatched) return;
  const keys = Object.keys(props);
  if (hasRuntimePropsDeclaration(comp)) {
    const declared = comp.props;
    // defineModel() can declare runtime props even after typed loader props are stripped.
    const missing = keys.filter((key) =>
      Array.isArray(declared) ? !declared.includes(key) : !Object.hasOwn(declared, key)
    );
    if (missing.length === 0) return;
    comp.props = Array.isArray(declared)
      ? [...declared, ...missing]
      : { ...Object.fromEntries(missing.map((key) => [key, null])), ...declared };
  } else {
    comp.props = keys;
  }
  comp.__voidPatched = true;
}
`;

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
  const normalizedPagesDir = normalizePath(pagesDir);
  return [
    {
      name: 'void-vue:pages-transform',
      enforce: 'pre',

      transform: {
        filter: { id: /\.vue$/ },
        handler(code, id) {
          if (!isVuePageFile(normalizePath(id), normalizedPagesDir)) {
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
          if (!isVuePageFile(normalizePath(ctx.file), normalizedPagesDir)) {
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
    createPagesPlugin(pagesDir, {
      name: 'void-vue:pages',
      root: options?.root,
      generateRenderer(scan) {
        return generateRendererModule(scan, pagesDir);
      },
      generateClient(scan, staticPageData) {
        return generateClientEntry(
          scan,
          pagesDir,
          options?.viewTransitions,
          options?.prefetch,
          staticPageData,
        );
      },
      config({ isDev }) {
        if (isDev) {
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
    }),
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

${PATCH_PROPS_RUNTIME}

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

  const html = await renderToString(app);
  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${assetTags.css}\${assetTags.preloads}</head>
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

${PATCH_PROPS_RUNTIME}

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

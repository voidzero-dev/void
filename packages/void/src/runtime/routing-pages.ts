import { Context, type MiddlewareHandler } from 'hono';
import {
  PRESERVED_QUERY_HEADER,
  markActionKey,
  searchWithoutPreservedQuery,
} from '../pages/action-key.ts';
import {
  handlesPageLoaderNotFound,
  ownsLoaderNotFoundBoundary,
} from '../pages/not-found-context.ts';
import { handlePageGet, handlePageMutation } from '../pages/protocol.ts';
import { decodePagePath } from '../pages/url.ts';
import type { ClientAssetTags } from './routing-assets.ts';
import type { ErrorRenderer } from './routing-errors.ts';
import { createAssetCachePolicy } from './routing-worker.ts';
import type { RoutingRule, RoutingRuntime } from './routing.ts';
import { markStaticAsset } from './static-asset-marker.ts';

type PageGetArguments = Parameters<typeof handlePageGet>;
type PageModule = {
  loader?: PageGetArguments[0];
  head?: PageGetArguments[1];
  action?: Parameters<typeof handlePageMutation>[0];
  actions?: Record<string, Parameters<typeof handlePageMutation>[0]>;
};
export type PageRouteOptions = {
  load?: () => Promise<PageModule>;
  head?: PageGetArguments[1];
  componentId: string;
  render: PageGetArguments[4];
  assets: PageGetArguments[5];
  headConfig: PageGetArguments[6] | null;
  renderOptions: PageGetArguments[7];
  namedActions?: boolean;
  trailingSlash?: boolean;
  catchAllParam?: string;
};
// Hono's trie matcher cannot match a named catch-all followed by a literal slash.
// Register that route without the slash, then enforce the public URL and exclude
// the final separator from the parameter before invoking application code.
function preparePageRequest(c: Context, options: PageRouteOptions): boolean {
  if (!options.trailingSlash) {
    return true;
  }
  if (!c.req.path.endsWith('/')) {
    return false;
  }
  if (options.catchAllParam) {
    const params = c.req.param();
    params[options.catchAllParam] = params[options.catchAllParam].slice(0, -1);
    c.req.param = ((key?: string) => (key ? params[key] : { ...params })) as typeof c.req.param;
  }
  return true;
}
function actionNameOf(request: Request): string | undefined {
  // The copied page query is data for the action and loader, not an action selector.
  const search = searchWithoutPreservedQuery(
    new URL(request.url).search,
    request.headers.get(PRESERVED_QUERY_HEADER),
  );
  return new URLSearchParams(search).keys().next().value;
}
const routeHandlers = new WeakSet<Function>();
const namedActionHandlers = new WeakSet<Function>();
/** Records a handler that answers a route, so the marker can tell it from middleware. */
export function markRouteHandler<T extends Function>(handler: T): T {
  routeHandlers.add(handler);
  return handler;
}
/**
 * Runs before auth and user middleware, so a c.redirect() there leaves the
 * action key out too. It marks the request only when a page with named actions
 * is the route that will answer it, not when a broad page pattern also matches.
 *
 * `matchedRoutes` comes from 'hono/route' of the same Hono copy as the app: it
 * reads the request through a Symbol that each copy defines for itself.
 */
export function createNamedActionMarker(
  matchedRoutes: (c: Context) => Array<{ handler: Function }>,
): MiddlewareHandler {
  return async (c, next) => {
    const answer = matchedRoutes(c)
      .slice(c.req.routeIndex + 1)
      .find((route) => routeHandlers.has(route.handler));
    if (answer && namedActionHandlers.has(answer.handler) && actionNameOf(c.req.raw)) {
      markActionKey(c.req.raw);
    }
    await next();
  };
}
export function createPageGetHandler(options: PageRouteOptions): (c: Context) => Promise<Response> {
  return markRouteHandler(async (context: Context) => {
    if (!preparePageRequest(context, options)) {
      return context.notFound();
    }
    let mod: PageModule;
    try {
      mod = options.load ? await options.load() : { head: options.head };
    } catch (error) {
      mod = {
        loader: () => {
          throw error;
        },
      };
    }
    return handlePageGet(
      mod.loader,
      mod.head,
      context as PageGetArguments[2],
      options.componentId,
      options.render,
      options.assets,
      options.headConfig ?? undefined,
      options.renderOptions,
    );
  });
}

/** Build-only rendering bypasses application middleware and serializes no request data. */
export function createStaticNotFound(
  options: PageRouteOptions,
): (request: Request, env: Record<string, unknown>) => Promise<Response> {
  const handle = createPageGetHandler({
    ...options,
    renderOptions: { ...options.renderOptions, renderMode: 'server' },
    render: (page, assets, url) =>
      options.render({ ...page, documentOnly: true }, { ...assets, body: '', preloads: '' }, url),
  });
  return (request, env) => handle(new Context(new Request(new URL('/404', request.url)), { env }));
}
export function createPageMutationHandler(
  options: PageRouteOptions,
): (c: Context) => Promise<Response> {
  const mutationHandler = async (context: Context) => {
    if (!preparePageRequest(context, options)) {
      return context.notFound();
    }
    const mod = options.load ? await options.load() : {};
    const actionName = options.namedActions ? actionNameOf(context.req.raw) : undefined;
    // The name comes from the query string, so only own function properties
    // count; `?constructor` or `?valueOf` must not reach Object.prototype.
    const name = actionName || 'default';
    const named = mod.actions;
    const candidate = named && Object.hasOwn(named, name) ? named[name] : undefined;
    const handler = options.namedActions
      ? typeof candidate === 'function'
        ? candidate
        : undefined
      : mod.action;
    if (options.namedActions && !handler) {
      return new Response('Unknown action' + (actionName ? ': ' + actionName : ''), {
        status: 404,
      });
    }
    if (actionName) {
      markActionKey(context.req.raw);
    }
    return handlePageMutation(
      handler,
      mod.loader,
      mod.head,
      context as PageGetArguments[2],
      options.componentId,
      options.render,
      options.assets,
      options.headConfig ?? undefined,
      options.renderOptions,
    );
  };
  if (options.namedActions) {
    namedActionHandlers.add(mutationHandler);
  }
  return markRouteHandler(mutationHandler);
}

export function createPagesFallback(options: {
  pageNotFound?: (c: Context) => Promise<Response>;
  trailingSlash?: boolean;
  pagePatterns?: Array<RegExp>;
  routing: RoutingRuntime;
  errors: ErrorRenderer;
  fallbackRules?: Array<RoutingRule>;
  assetsDir?: string;
}): (c: Context) => Promise<Response> {
  const cachePolicy = createAssetCachePolicy(options.assetsDir);
  return async (c) => {
    // The loader's own boundary owns this 404; skip root rendering and asset fallbacks.
    if (ownsLoaderNotFoundBoundary(c)) {
      return c.newResponse(null, 404);
    }
    const path = c.req.path;
    if (
      path === '/api' ||
      path.startsWith('/api/') ||
      (c.req.method !== 'GET' && c.req.method !== 'HEAD')
    ) {
      return c.text('Not Found', 404);
    }
    const assets = c.env?.ASSETS;
    // A loader that called `c.notFound()` already claimed this URL. Serving a
    // static file that happens to share the path would turn its bytes into the
    // loader's return value, so answer from the not-found path instead.
    const assetResponse: Response = handlesPageLoaderNotFound(c)
      ? new Response('Not Found', { status: 404 })
      : assets && typeof assets.fetch === 'function'
        ? await assets.fetch(c.req.raw)
        : options.routing.markNoMatch(c.req.raw, new Response('Not Found', { status: 404 }));
    const filePath = path.includes('/.') || path.substring(path.lastIndexOf('/') + 1).includes('.');
    // Directory indexes may be served without a redirect by the asset binding.
    // Dynamic page patterns also match real files, which must keep their URLs.
    const pageNeedsSlash =
      options.trailingSlash &&
      !path.endsWith('/') &&
      options.pagePatterns?.some((pattern) => pattern.test(decodePagePath(`${path}/`)));
    let directoryIndex = false;
    if (
      pageNeedsSlash &&
      assetResponse.status === 200 &&
      assetResponse.headers.get('Content-Type')?.split(';')[0] === 'text/html' &&
      assets
    ) {
      const url = new URL(c.req.url);
      url.pathname += '/';
      // Node adapters can expose Request wrappers whose native getters cannot
      // be read as RequestInit. Copy only what this GET/HEAD probe needs.
      const index = await assets.fetch(
        new Request(url, {
          method: c.req.method,
          headers: c.req.raw.headers,
          redirect: c.req.raw.redirect,
          signal: c.req.raw.signal,
        }),
      );
      directoryIndex = index.status === 200;
      await index.body?.cancel();
    }
    if (pageNeedsSlash && (assetResponse.status === 404 || directoryIndex)) {
      await assetResponse.body?.cancel();
      const url = new URL(c.req.url);
      url.pathname += '/';
      return Response.redirect(url.href, 301);
    }
    if (assetResponse.status !== 404) {
      return markStaticAsset(c, await cachePolicy(c.req.raw, c.env, assetResponse));
    }
    const fallback = options.fallbackRules
      ? await options.routing.applyFallback(c, options.fallbackRules)
      : undefined;
    if (fallback) {
      return fallback;
    }
    if (filePath) {
      return options.errors.serveCustomPage(c, 404, 'Not Found');
    }
    if (path !== '/' && (options.trailingSlash ? !path.endsWith('/') : path.endsWith('/'))) {
      const url = new URL(c.req.url);
      url.pathname = options.trailingSlash ? `${path}/` : path.slice(0, -1);
      return Response.redirect(url.href, 301);
    }
    const destination = c.req.header('Sec-Fetch-Dest');
    const accept = c.req.header('Accept');
    const pageRequest =
      c.req.header('X-VoidPages') === 'true' ||
      ((!destination || destination === 'document' || destination === 'empty') &&
        (!accept || accept.includes('text/html') || accept.includes('*/*')));
    return options.routing.markNoMatch(
      c.req.raw,
      await (options.pageNotFound && pageRequest
        ? options.pageNotFound(c)
        : options.errors.serveCustomPage(c, 404, 'Not Found')),
    );
  };
}

type SsrModule = {
  render?: (c: Context, assets: ClientAssetTags) => Response | Promise<Response>;
  default?: (c: Context, assets: unknown) => Promise<Response>;
};
export function createSsrFallback(options: {
  routing: RoutingRuntime;
  nodeTarget?: boolean;
  fallbackRules?: Array<RoutingRule>;
  load: () => Promise<SsrModule>;
  assets: (request: Request, env: Context['env']) => Promise<ClientAssetTags>;
  assetsDir?: string;
}): (c: Context) => Promise<Response> {
  const cachePolicy = createAssetCachePolicy(options.assetsDir);
  const fetchAssets = async (c: Context): Promise<Response> => {
    const binding = c.env?.ASSETS;
    if (!binding || typeof binding.fetch !== 'function') {
      return options.routing.markNoMatch(c.req.raw, new Response('Not Found', { status: 404 }));
    }
    const response: Response = await binding.fetch(c.req.raw);
    return response.status === 404
      ? options.routing.markNoMatch(c.req.raw, new Response('Not Found', { status: 404 }))
      : markStaticAsset(c, await cachePolicy(c.req.raw, c.env, response));
  };
  return async (c) => {
    if (options.nodeTarget && options.fallbackRules) {
      const fallback = await options.routing.applyFallback(c, options.fallbackRules);
      if (fallback) {
        return fallback;
      }
    }
    const path = c.req.path;
    const destination = c.req.header('sec-fetch-dest');
    if (
      path === '/api' ||
      path.startsWith('/api/') ||
      /\/[^/]+\.[^/]+$/.test(path) ||
      (destination && destination !== 'document' && destination !== 'empty')
    ) {
      const response = await fetchAssets(c);
      if (!options.nodeTarget && options.fallbackRules && response.status === 404) {
        const fallback = await options.routing.applyFallback(c, options.fallbackRules);
        if (fallback) {
          return fallback;
        }
      }
      return response;
    }
    const mod = await options.load();
    const render = typeof mod.render === 'function' ? mod.render : mod.default;
    if (typeof render !== 'function') {
      throw new Error('ssr: Invalid entry. Export render(c, assetTags).');
    }
    return options.routing.preserveNotFound(
      await render(c, await options.assets(c.req.raw, c.env)),
    );
  };
}
export function createAssetNotFound(options: {
  routing: RoutingRuntime;
  nodeTarget?: boolean;
  fallbackRules?: Array<RoutingRule>;
  assetsDir?: string;
}): (c: Context) => Promise<Response> {
  const cachePolicy = createAssetCachePolicy(options.assetsDir);
  return async (c) => {
    if (!options.nodeTarget) {
      const assets = c.env?.ASSETS;
      if (assets && typeof assets.fetch === 'function') {
        const response: Response = await assets.fetch(c.req.raw);
        if (response.status !== 404) {
          return markStaticAsset(c, await cachePolicy(c.req.raw, c.env, response));
        }
      }
    }
    const fallback = options.fallbackRules
      ? await options.routing.applyFallback(c, options.fallbackRules)
      : undefined;
    return (
      fallback ?? options.routing.markNoMatch(c.req.raw, new Response('Not Found', { status: 404 }))
    );
  };
}

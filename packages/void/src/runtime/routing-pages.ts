import type { Context, MiddlewareHandler } from 'hono';
import { markActionKey } from '../pages/action-key.ts';
import { handlePageGet, handlePageMutation } from '../pages/protocol.ts';
import type { ClientAssetTags } from './routing-assets.ts';
import type { ErrorRenderer } from './routing-errors.ts';
import { createAssetCachePolicy } from './routing-worker.ts';
import type { RoutingRule, RoutingRuntime } from './routing.ts';

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
};
function actionNameOf(url: string): string | undefined {
  return new URL(url).searchParams.keys().next().value;
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
    if (answer && namedActionHandlers.has(answer.handler) && actionNameOf(c.req.url)) {
      markActionKey(c.req.raw);
    }
    await next();
  };
}
export function createPageGetHandler(options: PageRouteOptions): (c: Context) => Promise<Response> {
  return markRouteHandler(async (context: Context) => {
    const mod = options.load ? await options.load() : { head: options.head };
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
export function createPageMutationHandler(
  options: PageRouteOptions,
): (c: Context) => Promise<Response> {
  const mutationHandler = async (context: Context) => {
    const mod = options.load ? await options.load() : {};
    const actionName = options.namedActions ? actionNameOf(context.req.url) : undefined;
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
  routing: RoutingRuntime;
  errors: ErrorRenderer;
  fallbackRules?: Array<RoutingRule>;
  assetsDir?: string;
}): (c: Context) => Promise<Response> {
  const cachePolicy = createAssetCachePolicy(options.assetsDir);
  return async (c) => {
    const path = c.req.path;
    if (
      path === '/api' ||
      path.startsWith('/api/') ||
      (c.req.method !== 'GET' && c.req.method !== 'HEAD')
    ) {
      return c.text('Not Found', 404);
    }
    const assets = c.env?.ASSETS;
    const assetResponse: Response =
      assets && typeof assets.fetch === 'function'
        ? await assets.fetch(c.req.raw)
        : options.routing.markNoMatch(c.req.raw, new Response('Not Found', { status: 404 }));
    if (assetResponse.status !== 404) {
      return cachePolicy(c.req.raw, c.env, assetResponse);
    }
    const fallback = options.fallbackRules
      ? await options.routing.applyFallback(c, options.fallbackRules)
      : undefined;
    if (fallback) {
      return fallback;
    }
    if (path.includes('/.') || path.substring(path.lastIndexOf('/') + 1).includes('.')) {
      return options.errors.serveCustomPage(c, 404, 'Not Found');
    }
    if (path !== '/' && path.endsWith('/')) {
      const url = new URL(c.req.url);
      url.pathname = path.slice(0, -1);
      return Response.redirect(url.href, 301);
    }
    return options.routing.markNoMatch(
      c.req.raw,
      await options.errors.serveCustomPage(c, 404, 'Not Found'),
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
      : cachePolicy(c.req.raw, c.env, response);
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
    return render(c, await options.assets(c.req.raw, c.env));
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
          return cachePolicy(c.req.raw, c.env, response);
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

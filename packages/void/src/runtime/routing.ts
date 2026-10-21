import { AsyncLocalStorage } from 'node:async_hooks';
import {
  compilePattern,
  matchPattern,
  matchPatternCaptures,
  mergeQueryIntoLocation,
  substituteParams,
} from '@void/edge';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { RedirectStatusCode } from 'hono/utils/http-status';
import {
  actionKeySegment,
  hasActionKey,
  markActionKey,
  searchWithoutActionKey,
} from '../pages/action-key.ts';
import { VoidAssetRewriteError } from './handler.ts';
import { convertReturnValue } from './response.ts';
import { ASSET_EXTENSIONS } from './routing-assets.ts';
import { markRouteHandler } from './routing-pages.ts';
export { createErrorRenderer } from './routing-errors.ts';

export type RoutingRule = {
  source: string;
  destination: string;
  status: number;
  host?: string;
  force?: boolean;
  origin?: string;
};
export type RoutingHeaderRule = { pattern: string; headers: Array<[string, string]> };
export type RequestContextStore = { request: Request; executionCtx?: Context['executionCtx'] };
export type RoutingContext = Context & {
  rewrite: (path: string) => Promise<Response>;
  originalUrl: () => URL | null;
  isRewritten: () => boolean;
};
export type RoutingRuntime = {
  requestContext: AsyncLocalStorage<RequestContextStore>;
  contextMiddleware: MiddlewareHandler;
  requestMiddleware: MiddlewareHandler;
  routingMiddleware: (rules: Array<RoutingRule>) => MiddlewareHandler;
  headerMiddleware: (rules: Array<RoutingHeaderRule>) => MiddlewareHandler;
  applyFallback: (context: Context, rules: Array<RoutingRule>) => Promise<Response | undefined>;
  markNoMatch: (request: Request, response: Response) => Response;
};

/** One state owner per generated app: recursive dispatch shares rewrite and fallback guards. */
export function createRoutingRuntime(
  app: Hono,
  options: {
    dev?: boolean;
    nodeTarget?: boolean;
    managedDispatch?: boolean;
    blockedAssetExtensions?: Array<string>;
  } = {},
): RoutingRuntime {
  const originalUrls = new WeakMap<Request, URL>();
  const fallbackHandled = new WeakSet<Request>();
  const warnedPatterns = new Set<string>();
  const requestContext = new AsyncLocalStorage<RequestContextStore>();
  const assetExtensions = options.blockedAssetExtensions ?? ASSET_EXTENSIONS;
  const assetExtensionRE = assetExtensions.length
    ? new RegExp(`\\.(${assetExtensions.join('|')})$`, 'i')
    : /(?!)/;
  const annotate = (response: Response, trace: string): Response => {
    if (!options.dev) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set('X-Void-Routing', trace);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  const dispatch = (request: Request, c: Context): Promise<Response> =>
    Promise.resolve(
      options.nodeTarget ? app.fetch(request, c.env) : app.fetch(request, c.env, c.executionCtx),
    );
  const rememberOriginal = (request: Request, c: Context): void => {
    originalUrls.set(request, originalUrls.get(c.req.raw) ?? new URL(c.req.url));
  };
  const warn = (pattern: string, error: unknown, kind: 'header' | 'routing'): void => {
    if (warnedPatterns.has(pattern)) {
      return;
    }
    warnedPatterns.add(pattern);
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      kind === 'routing'
        ? `[void] skipping routing rule with invalid source ${JSON.stringify(pattern)}: ${detail}`
        : `[void] failed to compile route pattern ${JSON.stringify(pattern)}: ${detail}`,
    );
  };
  const applyRules = async (
    c: Context,
    rules: Array<RoutingRule>,
    fallback: boolean,
  ): Promise<Response | undefined> => {
    const url = new URL(c.req.url);
    for (const rule of rules) {
      if (rule.host && rule.host !== url.hostname) {
        continue;
      }
      try {
        compilePattern(rule.source);
      } catch (error) {
        warn(rule.source, error, 'routing');
        continue;
      }
      const params = matchPatternCaptures(rule.source, url.pathname);
      if (!params) {
        continue;
      }
      const destination = substituteParams(rule.destination, params);
      if (rule.status === 200) {
        const q = destination.indexOf('?');
        const rewriteUrl = new URL(c.req.url);
        rewriteUrl.pathname = q === -1 ? destination : destination.slice(0, q);
        const search = q === -1 ? '' : destination.slice(q);
        if (search) {
          rewriteUrl.search = search;
        }
        const request = new Request(rewriteUrl.toString(), c.req.raw);
        rememberOriginal(request, c);
        keepActionKey(c.req.raw, request, search);
        if (fallback) {
          fallbackHandled.add(request);
        }
        const response = await dispatch(request, c);
        const kind = rule.force === true ? 'rewrite' : 'fallback';
        return annotate(
          response,
          `${kind}[${rule.source}] -> ${destination} (${rule.origin || 'unknown'})`,
        );
      }
      const location = mergeQueryIntoLocation(destination, url.search);
      return annotate(
        c.redirect(location, rule.status as RedirectStatusCode),
        `redirect[${rule.source}] -> ${destination} ${rule.status} (${rule.origin || 'unknown'})`,
      );
    }
  };
  const contextMiddleware: MiddlewareHandler = async (context, next) => {
    const c = context as RoutingContext;
    if (options.managedDispatch && !originalUrls.has(c.req.raw)) {
      const original = c.req.raw.headers.get('X-Void-Original-URL');
      if (original != null) {
        try {
          originalUrls.set(c.req.raw, new URL(original));
        } catch {
          /* Ignore malformed dispatcher metadata. */
        }
      }
    }
    c.rewrite = (path) => {
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error(
          'c.rewrite() only accepts internal, path-absolute destinations — they must start with a single "/" (a leading "//" parses as protocol-relative and would proxy cross-origin); use fetch() for external URLs',
        );
      }
      const q = path.indexOf('?');
      const h = path.indexOf('#');
      const first = q === -1 ? h : h === -1 ? q : Math.min(q, h);
      const pathname = first === -1 ? path : path.slice(0, first);
      if (assetExtensionRE.test(pathname)) {
        throw new VoidAssetRewriteError(path);
      }
      const search = q === -1 ? '' : path.slice(q, h === -1 ? path.length : h);
      const url = new URL(c.req.url);
      url.pathname = pathname;
      if (search) {
        url.search = search;
      }
      const request = new Request(url.toString(), c.req.raw);
      rememberOriginal(request, c);
      keepActionKey(c.req.raw, request, search);
      return dispatch(request, c).then((response) =>
        annotate(response, `c.rewrite -> ${path} (middleware)`),
      );
    };
    const redirect = c.redirect.bind(c);
    c.redirect = (location, status) => {
      if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')) {
        return redirect(redirectLocation(c.req.raw, location, status), status);
      }
      return redirect(location, status);
    };
    c.originalUrl = () => originalUrls.get(c.req.raw) ?? null;
    c.isRewritten = () => originalUrls.has(c.req.raw);
    await next();
  };
  return {
    requestContext,
    contextMiddleware,
    requestMiddleware: async (c, next) => {
      await requestContext.run(
        options.nodeTarget
          ? { request: c.req.raw }
          : { request: c.req.raw, executionCtx: c.executionCtx },
        next,
      );
    },
    routingMiddleware: (rules) => async (c, next) => {
      if (originalUrls.has(c.req.raw)) {
        return next();
      }
      const response = await applyRules(c, rules, false);
      if (response) {
        return response;
      }
      await next();
      if (options.dev && c.res && !c.res.headers.has('X-Void-Routing')) {
        try {
          c.res.headers.set('X-Void-Routing', 'pass-through');
        } catch {
          /* Headers may be immutable. */
        }
      }
    },
    headerMiddleware: (rules) => async (c, next) => {
      await next();
      const pathname = new URL(c.req.url).pathname;
      const matched: Array<[string, string]> = [];
      for (const rule of rules) {
        try {
          compilePattern(rule.pattern);
        } catch (error) {
          warn(rule.pattern, error, 'header');
          continue;
        }
        if (matchPattern(rule.pattern, pathname)) {
          matched.push(...rule.headers);
        }
      }
      if (!matched.length) {
        return;
      }
      const headers = new Headers(c.res.headers);
      for (const [name, value] of matched) {
        headers.set(name, value);
      }
      c.res = new Response(c.res.body, {
        headers,
        status: c.res.status,
        statusText: c.res.statusText,
      });
    },
    applyFallback: (c, rules) =>
      fallbackHandled.has(c.req.raw) ? Promise.resolve(undefined) : applyRules(c, rules, true),
    markNoMatch,
  };
}

function redirectLocation(
  request: Request,
  location: string,
  status: RedirectStatusCode | undefined,
): string {
  const url = new URL(request.url);
  const search = url.search;
  if (!hasActionKey(request)) {
    return mergeQueryIntoLocation(location, search);
  }
  // The key goes only when the browser follows with a GET: after a 303, or after
  // a 301/302 (the default) to a POST. Other redirects send the same method and
  // body again, and the destination needs the key to pick the action.
  const followsWithGet =
    status === 303 ||
    ((status === undefined || status === 301 || status === 302) && request.method === 'POST');
  if (followsWithGet) {
    return mergeQueryIntoLocation(location, searchWithoutActionKey(search));
  }
  const hash = location.indexOf('#');
  const destinationQuery = location.indexOf('?');
  if (destinationQuery === -1 || (hash !== -1 && hash < destinationQuery)) {
    return mergeQueryIntoLocation(location, search);
  }
  const merged = mergeQueryIntoLocation(location, searchWithoutActionKey(search));
  // On the same page, a key the destination starts with picks the action itself.
  const destinationKey = actionKeySegment(
    location.slice(destinationQuery, hash === -1 ? location.length : hash),
  );
  if (destinationKey && new URL(location, url).pathname === url.pathname) {
    return merged;
  }
  // Elsewhere the key goes first again, ahead of the destination parameters; a
  // value the destination gives the same key wins. A bare "?" still drops the
  // rest of the request query.
  const mergedHash = merged.indexOf('#');
  const base = mergedHash === -1 ? merged : merged.slice(0, mergedHash);
  const fragment = mergedHash === -1 ? '' : merged.slice(mergedHash);
  const q = base.indexOf('?');
  const segments = q === -1 ? [] : base.slice(q + 1).split('&');
  const key = actionKeySegment(search);
  const name = queryKey(key);
  const hasName = (segment: string) => segment !== '' && queryKey(segment) === name;
  // Only the destination's own value replaces the key. The merge then left out
  // the request's values for that name and put the destination's first.
  const own = location
    .slice(destinationQuery + 1, hash === -1 ? location.length : hash)
    .split('&')
    .some(hasName)
    ? segments.findIndex(hasName)
    : -1;
  const first = own === -1 ? key : segments.splice(own, 1)[0];
  const rest = segments.join('&');
  return (
    base.slice(0, q === -1 ? base.length : q) + '?' + first + (rest ? '&' + rest : '') + fragment
  );
}

function queryKey(segment: string): string | undefined {
  return new URLSearchParams(segment).keys().next().value;
}

/** A rewrite that keeps the query keeps the action key in it too. */
function keepActionKey(from: Request, to: Request, destinationSearch: string): void {
  if (!destinationSearch && hasActionKey(from)) {
    markActionKey(to);
  }
}

export function markNoMatch(request: Request, response: Response): Response {
  const url = new URL(request.url);
  if (
    response.status !== 404 ||
    (request.method !== 'GET' && request.method !== 'HEAD') ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    /\/[^/]+\.[^/]+$/.test(url.pathname)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('X-Void-No-Match', '1');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createHttpRouteHandler(
  load: () => Promise<Record<string, (c: Context) => unknown>>,
  method: string,
): (c: Context) => Promise<Response> {
  return markRouteHandler(async (c: Context) =>
    convertReturnValue(await (await load())[method](c)),
  );
}

export {
  createPageGetHandler,
  createPageMutationHandler,
  createPagesFallback,
  createNamedActionMarker,
  markRouteHandler,
} from './routing-pages.ts';

export function createModuleLoader<T>(load: () => Promise<T>, cache = true): () => Promise<T> {
  let module: T | undefined;
  return async () => {
    if (!cache) {
      return load();
    }
    if (!module) {
      module = await load();
    }
    return module;
  };
}
export {
  createAssetFallback,
  createWorkerFetch,
  filterInternalBindings,
} from './routing-worker.ts';
export { createClientAssetTags, createManifestLoader } from './routing-assets.ts';
export { createSsrFallback, createAssetNotFound } from './routing-pages.ts';

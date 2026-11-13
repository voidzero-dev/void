import { AsyncLocalStorage } from 'node:async_hooks';
import {
  compilePattern,
  matchPattern,
  matchPatternCaptures,
  mergeQueryIntoLocation,
  substituteParams,
} from '@void/edge';
import type { Context, Hono, MiddlewareHandler, NotFoundHandler } from 'hono';
import type { TypedResponse } from 'hono';
import type { RedirectStatusCode } from 'hono/utils/http-status';
import type { RouteDestination, RouteUrlInput } from 'void/routes';
import {
  PRESERVED_QUERY_HEADER,
  actionKeySegment,
  hasActionKey,
  markActionKey,
  queryKey,
  searchWithoutActionKey,
  searchWithoutPreservedQuery,
} from '../pages/action-key.ts';
import { pagesRedirectResponse } from '../pages/redirect.ts';
import { SHARED_CACHE_HEADERS, authDependentRequests } from './auth-response.ts';
import { VoidAssetRewriteError, type CloudContext } from './handler.ts';
import { convertReturnValue } from './response.ts';
import { toUrlString } from './route-url.ts';
import { ASSET_EXTENSIONS } from './routing-assets.ts';
import { markRouteHandler } from './routing-pages.ts';
import { intentionalNotFoundRequests } from './routing-worker.ts';
import { isUnchangedStaticAsset, markStaticAsset } from './static-asset-marker.ts';
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
  redirect: <T extends RedirectStatusCode = 302>(
    location: RouteUrlInput,
    status?: T,
  ) => Response & TypedResponse<undefined, T, 'redirect'>;
  rewrite: (path: string | RouteDestination) => Promise<Response>;
  originalUrl: () => URL | null;
  isRewritten: () => boolean;
};
export type RoutingRuntime = {
  requestContext: AsyncLocalStorage<RequestContextStore>;
  contextMiddleware: MiddlewareHandler;
  trackNotFound: (handler?: NotFoundHandler) => NotFoundHandler;
  preserveNotFound: (response: Response) => Response;
  requestMiddleware: MiddlewareHandler;
  routingMiddleware: (rules: Array<RoutingRule>) => MiddlewareHandler;
  headerMiddleware: (rules: Array<RoutingHeaderRule>, phase?: 'auth-error') => MiddlewareHandler;
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
  // Outer requests a fallback answered. The fallback already applied the
  // destination's header rules, as edge routing and platform dispatch do.
  const fallbackServed = new WeakSet<Request>();
  // Contexts whose inner header pass ran after next(). A handler that throws
  // past it, such as notFound, leaves the context out.
  const headerApplied = new WeakSet<Context>();
  const explicitNotFound = new WeakSet<Context>();
  let trackAssetMisses = false;
  const intentionalResponses = new WeakSet<Response>();
  const routeMisses = new WeakMap<Context, Array<Response>>();
  const missBodies = new WeakMap<Context, WeakSet<ReadableStream>>();
  const trackMissBody = (c: Context, body: ReadableStream | null): void => {
    if (!body) {
      return;
    }
    let bodies = missBodies.get(c);
    if (!bodies) {
      bodies = new WeakSet();
      missBodies.set(c, bodies);
    }
    if (bodies.has(body)) {
      return;
    }
    bodies.add(body);
    // Middleware such as Hono's compress() replaces the body with a transform
    // of this stream. That still carries a miss; an unrelated replacement does not.
    if (Object.isExtensible(body)) {
      const pipeThrough = body.pipeThrough;
      Object.defineProperty(body, 'pipeThrough', {
        configurable: true,
        writable: true,
        value(this: ReadableStream, ...args: Parameters<ReadableStream['pipeThrough']>) {
          const transformed = pipeThrough.apply(this, args);
          if (this === body) {
            trackMissBody(c, transformed);
          }
          return transformed;
        },
      });
    }
  };
  const recordMiss = (c: Context, response: Response): void => {
    const misses = routeMisses.get(c) ?? [];
    if (misses.includes(response)) {
      return;
    }
    misses.push(response);
    routeMisses.set(c, misses);
    trackMissBody(c, response.body);
    trackResponseCopies(c);
    // Fetch's clone tees the body, so neither clone shares its former stream.
    if (Object.isExtensible(response)) {
      const clone = response.clone;
      Object.defineProperty(response, 'clone', {
        configurable: true,
        writable: true,
        value(this: Response) {
          const copy = clone.call(this);
          if (this === response) {
            trackMissBody(c, this.body);
            recordMiss(c, copy);
          }
          return copy;
        },
      });
    }
  };
  const isRouteMiss = (c: Context, response: Response): boolean =>
    routeMisses
      .get(c)
      ?.some((miss) => miss === response || (miss.body !== null && miss.body === response.body)) ===
      true ||
    (response.body !== null && missBodies.get(c)?.has(response.body) === true);
  const tracksResponseCopies = new WeakSet<Context>();
  const trackResponseCopies = (c: Context): void => {
    if (tracksResponseCopies.has(c)) {
      return;
    }
    tracksResponseCopies.add(c);
    // Carry provenance to the response Hono exposes after assignment or a header edit.
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), 'res');
    if (descriptor?.get && descriptor.set) {
      const set = descriptor.set;
      Object.defineProperty(c, 'res', {
        ...descriptor,
        set(response: Response | undefined) {
          set.call(c, response);
          if (response && isRouteMiss(c, response) && c.res !== response) {
            recordMiss(c, c.res);
          }
        },
      });
    }
    const header = c.header.bind(c);
    c.header = (...args) => {
      const before = c.finalized ? c.res : undefined;
      header(...args);
      if (before && c.res !== before && isRouteMiss(c, before)) {
        recordMiss(c, c.res);
      }
    };
  };
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
  const dispatch = async (request: Request, c: Context, trace: string): Promise<Response> => {
    const response = annotate(
      await (options.nodeTarget
        ? app.fetch(request, c.env)
        : app.fetch(request, c.env, c.executionCtx)),
      trace,
    );
    if (authDependentRequests.has(request)) {
      // The enclosing response may depend on auth even if middleware clones or replaces it.
      authDependentRequests.add(c.req.raw);
    }
    if (trackAssetMisses && response.status === 404) {
      if (intentionalNotFoundRequests.has(request)) {
        intentionalResponses.add(response);
      } else {
        recordMiss(c, response);
      }
    }
    return response;
  };
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
        keepActionQuery(c.req.raw, request, search);
        if (fallback) {
          fallbackHandled.add(request);
          fallbackServed.add(c.req.raw);
        }
        const kind = rule.force === true ? 'rewrite' : 'fallback';
        return dispatch(
          request,
          c,
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
    if (trackAssetMisses) {
      intentionalNotFoundRequests.delete(c.req.raw);
      const notFound = c.notFound.bind(c);
      // Hono calls its fallback directly when the router runs out of handlers.
      c.notFound = () => {
        explicitNotFound.add(c);
        try {
          return notFound();
        } finally {
          explicitNotFound.delete(c);
        }
      };
    }
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
    c.rewrite = (destination) => {
      const path = toUrlString(destination);
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
      keepActionQuery(c.req.raw, request, search);
      return dispatch(request, c, `c.rewrite -> ${path} (middleware)`);
    };
    const redirect = context.redirect.bind(context);
    c.redirect = (destination, status) => {
      const location = toUrlString(destination);
      // A named action still places its key and keeps the page query. Every
      // other code redirect sends the location it was given. routing.redirects
      // merge the request query before they call this.
      if (location.startsWith('/') && !location.startsWith('//') && hasActionKey(c.req.raw)) {
        return redirect(redirectLocation(c.req.raw, location, status), status);
      }
      return redirect(location, status);
    };
    c.originalUrl = () => originalUrls.get(c.req.raw) ?? null;
    c.isRewritten = () => originalUrls.has(c.req.raw);
    await next();
    c.res = pagesRedirectResponse(c.req.raw, c.res);
    if (!trackAssetMisses) {
      return;
    }
    if (c.res.status === 404 && !isRouteMiss(c, c.res)) {
      intentionalNotFoundRequests.add(c.req.raw);
    }
  };
  return {
    requestContext,
    contextMiddleware,
    trackNotFound: (handler = (c) => c.text('404 Not Found', 404)) => {
      trackAssetMisses = true;
      return (c) => {
        const explicit = explicitNotFound.has(c);
        const response = handler(c);
        if (explicit) {
          return response;
        }
        return Promise.resolve(response).then((miss) => {
          if (miss.status === 404 && !intentionalResponses.has(miss)) {
            recordMiss(c, miss);
          }
          return miss;
        });
      };
    },
    preserveNotFound: (response) => {
      if (trackAssetMisses && response.status === 404) {
        intentionalResponses.add(response);
      }
      return response;
    },
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
    headerMiddleware: (rules, phase) => async (c, next) => {
      const authErrorsOnly = phase === 'auth-error';
      await next();
      if (authErrorsOnly && (!c.error || headerApplied.has(c))) {
        return;
      }
      if (!authErrorsOnly) {
        headerApplied.add(c);
      }
      const protectCache = authErrorsOnly || authDependentRequests.has(c.req.raw);
      if (protectCache) {
        authDependentRequests.add(c.req.raw);
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');
        for (const name of SHARED_CACHE_HEADERS) {
          if (c.res.headers.has(name)) {
            c.header(name, undefined);
          }
        }
      }
      if (fallbackServed.has(c.req.raw)) {
        return;
      }
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
      // The last match wins for each header name, Set-Cookie included.
      const last = new Map<string, [string, string]>();
      for (const [name, value] of matched) {
        last.set(name.toLowerCase(), [name, value]);
      }
      const asset = isUnchangedStaticAsset(c);
      for (const [key, [name, value]] of last) {
        if (
          protectCache &&
          (key === 'cache-control' || key === 'pragma' || SHARED_CACHE_HEADERS.includes(key))
        ) {
          continue;
        }
        // A Set-Cookie rule adds its cookie and keeps the response's own cookies.
        // After a rewrite the destination's pass may already have added it last.
        if (key === 'set-cookie' && c.res.headers.getSetCookie().at(-1) === value) {
          continue;
        }
        c.header(name, value, { append: key === 'set-cookie' });
      }
      if (asset) {
        // A configured Cache-Control is the file's policy from here on, so auth
        // still treats the response as a static file and only makes it private.
        markStaticAsset(c, c.res);
      }
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
  // The page query that action() added only re-renders the page in place.
  const search = searchWithoutPreservedQuery(
    url.search,
    request.headers.get(PRESERVED_QUERY_HEADER),
  );
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

/** Action metadata follows a rewrite only when it keeps the request query. */
function keepActionQuery(from: Request, to: Request, destinationSearch: string): void {
  if (destinationSearch) {
    to.headers.delete(PRESERVED_QUERY_HEADER);
  } else if (hasActionKey(from)) {
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
  load: () => Promise<Record<string, (c: CloudContext) => unknown>>,
  method: string,
): (c: Context) => Promise<Response> {
  return markRouteHandler(async (c: Context) =>
    convertReturnValue(await (await load())[method](c as unknown as CloudContext)),
  );
}

export {
  createPageGetHandler,
  createPageErrorHandler,
  createStaticNotFound,
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
  prerenderPathsResponse,
} from './routing-worker.ts';
export { createClientAssetTags, createManifestLoader } from './routing-assets.ts';
export { createSsrFallback, createAssetNotFound } from './routing-pages.ts';
export { buildPrerenderPath } from './prerender-path.ts';

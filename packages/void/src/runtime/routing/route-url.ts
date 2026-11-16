import type { EncodedRoutePathMap, RoutePathMap, RouteTypesConfig } from 'void/routes';

/**
 * Encode one path segment of a route param. `encodeURIComponent` keeps dots, and
 * URL parsing resolves `.`/`..` (even as `%2e`), so such a segment would move the
 * request to another path instead of reaching this route.
 */
function encodeSegment(name: string, segment: string): string {
  if (segment === '.' || segment === '..') {
    throw new TypeError(
      `Route param "${name}" cannot be "${segment}"; it would change the request path.`,
    );
  }
  return encodeURIComponent(segment);
}

/** Expand complete route tokens without changing query strings or fragments. */
export function interpolateRouteParams(
  path: string,
  params?: Record<string, string>,
  requireParams = false,
): string {
  if (!params && !requireParams) {
    return path;
  }
  const suffixIndex = path.search(/[?#]/);
  const pathname = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : path.slice(suffixIndex);
  let leadingName: string | undefined;
  const replaced = pathname.replace(
    /(^|\/)(?::([^/{}]+)(\{\.\+\})?|\[(\.\.\.)?([^/[\]]*)\]|\*)(?=\/|$)/g,
    (
      token: string,
      prefix: string,
      name: string | undefined,
      catchAll: string | undefined,
      bracketCatchAll: string | undefined,
      bracketName: string | undefined,
      offset: number,
    ) => {
      name ??= bracketName || undefined;
      const anonymous = name === undefined;
      name ??= '*';
      if (!params || !Object.hasOwn(params, name)) {
        if (requireParams) {
          throw new TypeError(`Missing route param "${name}".`);
        }
        return token;
      }
      if (offset === 0) {
        leadingName = name;
      }
      const value = params[name];
      if (anonymous && value === '' && pathname.slice(offset + token.length) === '/') {
        return '';
      }
      if (requireParams && !anonymous && value === '') {
        throw new TypeError(`Route param "${name}" must not be empty.`);
      }
      return (
        prefix +
        (catchAll || bracketCatchAll || anonymous
          ? value
              .split('/')
              .map((segment) => encodeSegment(name, segment))
              .join('/')
          : encodeSegment(name, value))
      );
    },
  );
  // A path that starts with `//` is read as another host by fetch() and URL parsing.
  if (replaced.startsWith('//') && !pathname.startsWith('//')) {
    throw new TypeError(
      `Route param "${leadingName ?? ''}" would make the request path start with "//", which changes the request host.`,
    );
  }
  return replaced + suffix;
}

/** Known page, HTTP and WebSocket route patterns. */
export type RoutePath = keyof RoutePathMap & string;

// Dynamic segments in either public or legacy patterns match any text,
// so `/users/[id]` accepts `/users/${string}`. Template
// literal types cannot exclude empty or `/`-leading text without per-character unions.
type RouteUrlSegment<S extends string> = S extends `:${string}` | `[${string}]` | '*' ? string : S;
type RouteSegmentsUrl<P extends string> = P extends `${infer Segment}/${infer Rest}`
  ? `${RouteUrlSegment<Segment>}/${RouteSegmentsUrl<Rest>}`
  : RouteUrlSegment<P>;
// A trailing `/*` also matches the bare prefix, as in Hono: `/docs/*` matches `/docs`.
type RoutePatternUrl<P extends string> = P extends `${infer Prefix}/${'*' | '[...]'}/`
  ? `${RouteSegmentsUrl<Prefix>}/` | `${RouteSegmentsUrl<Prefix>}/${string}/`
  : P extends `${infer Prefix}/${'*' | '[...]'}`
    ? (Prefix extends '' ? '/' : RouteSegmentsUrl<Prefix>) | `${RouteSegmentsUrl<Prefix>}/${string}`
    : RouteSegmentsUrl<P>;
// Fixed segments are also accepted percent-encoded, as `routeUrl()` returns them.
type EncodedRoutePath = EncodedRoutePathMap[keyof EncodedRoutePathMap] & string;
type RoutePathUrl = RoutePatternUrl<RoutePath | EncodedRoutePath>;

/** Whether `routing.typedRoutes` is on in the generated route types. */
export type TypedRoutes = RouteTypesConfig extends { typedRoutes: true } ? true : false;

/** The URL of one of the app's routes. A plain string unless `routing.typedRoutes` is on. */
export type RouteUrl = TypedRoutes extends true
  ? RoutePathUrl | `${RoutePathUrl}${'?' | '#'}${string}`
  : string;

/** Anything a link can point to: a route URL, a same-page query or hash, or an external URL. */
export type Href = TypedRoutes extends true
  ? RouteUrl | `${'?' | '#'}${string}` | `${'http://' | 'https://' | 'mailto:' | 'tel:'}${string}`
  : string;

/**
 * A URL an HTTP request can target: one of the app's routes or an absolute
 * `http://`/`https://` URL. A plain string unless `routing.typedRoutes` is on.
 */
// Not re-exported from `void/routes`: apps cast runtime strings with `as RouteUrl`.
export type RequestUrl = TypedRoutes extends true
  ? RouteUrl | `${'http://' | 'https://'}${string}`
  : string;

export type RouteQueryValue = string | number | boolean | null | undefined;
export type RouteQuery = Record<string, RouteQueryValue | ReadonlyArray<RouteQueryValue>>;

export type RouteOptions<P extends RoutePath> = {
  query?: RouteQuery;
  hash?: string;
} & ([RoutePathMap[P]] extends [never]
  ? { params?: never }
  : { params: { [K in RoutePathMap[P] & string]: string | number } });

export type RouteDestination<P extends RoutePath = RoutePath> = P extends RoutePath
  ? { pathname: P } & RouteOptions<P>
  : never;

export type RouteUrlInput = Href | URL | RouteDestination;

type UrlOptions = {
  params?: Record<string, string | number>;
  query?: RouteQuery;
  hash?: string;
};

/** Build a relative URL from a known route pattern. */
export function routeUrl<P extends RoutePath>(
  path: P,
  ...args: [RoutePathMap[NoInfer<P>]] extends [never]
    ? [options?: RouteOptions<P>]
    : [options: RouteOptions<P>]
): RouteUrl {
  return buildRouteUrl(path, args[0]) as RouteUrl;
}

/** @internal Convert navigation inputs to URL strings without requiring an origin. */
export function toUrlString(value: RouteUrlInput): string;
// With an empty route map, RouteDestination is never. Keep the implementation's
// object input available for serialization while callers use the typed signature above.
export function toUrlString(value: string | URL | ({ pathname: string } & UrlOptions)): string {
  if (typeof value === 'string') {
    return value;
  }
  if ('href' in value && typeof value.href === 'string') {
    return value.href;
  }
  return buildRouteUrl(value.pathname, value);
}

function buildRouteUrl(path: string, options?: UrlOptions): string {
  const params = Object.fromEntries(
    Object.entries(options?.params ?? {}).map(([name, value]) => {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new TypeError(`Route param "${name}" must be a string or number.`);
      }
      return [name, String(value)];
    }),
  );
  const url = new URL('https://void.invalid');
  url.pathname = interpolateRouteParams(path, params, true);

  for (const [key, value] of Object.entries(options?.query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== null && item !== undefined) {
        url.searchParams.append(key, String(item));
      }
    }
  }
  if (options?.hash) {
    url.hash = options.hash;
  }
  return url.pathname + url.search + url.hash;
}

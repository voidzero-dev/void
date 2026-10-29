import type { RoutePathMap } from 'void/routes';

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
    /(^|\/)(?::([^/{}]+)(\{\.\+\})?|\*)(?=\/|$)/g,
    (
      token: string,
      prefix: string,
      name: string | undefined,
      catchAll: string | undefined,
      offset: number,
    ) => {
      const anonymous = name === undefined;
      if (anonymous && !requireParams) {
        return token;
      }
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
      if (requireParams && !anonymous && value === '') {
        throw new TypeError(`Route param "${name}" must not be empty.`);
      }
      return (
        prefix +
        (catchAll || anonymous
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

export type RouteQueryValue = string | number | boolean | null | undefined;
export type RouteQuery = Record<string, RouteQueryValue | ReadonlyArray<RouteQueryValue>>;

export type RouteOptions<P extends RoutePath> = {
  query?: RouteQuery;
  hash?: string;
} & ([RoutePathMap[P]] extends [never]
  ? { params?: never }
  : { params: { [K in RoutePathMap[P] & string]: string | number } });

/** Build a relative URL from a known route pattern. */
export function routeUrl<P extends RoutePath>(
  path: P,
  ...args: [RoutePathMap[NoInfer<P>]] extends [never]
    ? [options?: RouteOptions<P>]
    : [options: RouteOptions<P>]
): string {
  const options = args[0];
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

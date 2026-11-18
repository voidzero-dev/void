import { interpolateRouteParams } from './route-url.ts';

// Same complete-segment tokens as `interpolateRouteParams`: `:name`, `:name{.+}` and `*`.
const ROUTE_TOKEN = /(?:^|\/)(?::([^/{}]+)(\{\.\+\})?|\*)(?=\/|$)/g;

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (value === undefined) {
    return 'undefined';
  }
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** Validate one `getPrerenderPaths()` entry and convert the values its pattern uses to strings. */
function routeParams(pattern: string, params: unknown): Record<string, string> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TypeError(`Expected an object of route params, got ${describeValue(params)}.`);
  }
  const values: Record<string, string> = Object.create(null);
  for (const [, paramName, catchAll] of pattern.matchAll(ROUTE_TOKEN)) {
    const name = paramName ?? '*';
    if (!Object.hasOwn(params, name)) {
      // interpolateRouteParams reports the missing param.
      continue;
    }
    const value: unknown = (params as Record<string, unknown>)[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`Route param "${name}" must be a string or number.`);
    }
    const text = String(value);
    // A `/` in a one-segment param would build a URL this page does not match.
    // routeUrl() encodes it as %2F, but static hosts decode %2F before the
    // file lookup, so the prerendered file would never be served.
    if (paramName !== undefined && !catchAll && text.includes('/')) {
      throw new TypeError(
        `Route param "${name}" cannot contain "/". Use a catch-all page ([...${name}]) for nested paths.`,
      );
    }
    values[name] = text;
  }
  return values;
}

/**
 * Build the URL for one entry a page's `getPrerenderPaths()` returned. Values
 * are percent-encoded like `routeUrl()`. Errors name the server file and the
 * entry index, and fail the build: a wrong entry must not silently produce a
 * missing or misplaced page.
 */
export function buildPrerenderPath(
  pattern: string,
  params: unknown,
  file: string,
  index: number,
): string {
  try {
    return interpolateRouteParams(pattern, routeParams(pattern, params), true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${file} getPrerenderPaths()[${index}]: ${message}`);
  }
}

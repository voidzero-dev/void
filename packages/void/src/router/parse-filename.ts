import { ROUTE_EXTENSIONS } from '../shared/route-extensions.ts';

export type RouteEnvironment = 'dev' | 'prod';

export type RouteDefinition = {
  /** URL pattern, e.g. "/api/users/:id" */
  pattern: string;
  /** HTTP methods detected from named exports (e.g. ["GET", "POST"]) */
  methods: Array<string>;
  /** Parameter names extracted from the pattern */
  params: Array<string>;
  /** Whether this route has a catch-all parameter */
  catchAll: boolean;
  /** Environment restriction: "dev", "prod", or null */
  env: RouteEnvironment | null;
  /** Original relative file path */
  filePath: string;
};

const ENV_SUFFIXES: Array<RouteEnvironment> = ['dev', 'prod'];

function parsePath(relativePath: string, isWebSocketRoute: boolean): RouteDefinition {
  const filePath = relativePath;

  // Normalize path separators
  let path = relativePath.replace(/\\/g, '/');

  // 1. Strip extension
  for (const ext of ROUTE_EXTENSIONS) {
    if (path.endsWith(`.${ext}`)) {
      path = path.slice(0, -(ext.length + 1));
      break;
    }
  }

  // 1b. Strip .ws segment for WebSocket routes
  if (isWebSocketRoute && path.endsWith('.ws')) {
    path = path.slice(0, -3);
  }

  // Split into segments for processing
  const segments = path.split('/');
  let filename = segments.pop()!;

  // 2. Check for env suffix
  let env: RouteEnvironment | null = null;
  for (const suffix of ENV_SUFFIXES) {
    if (filename.endsWith(`.${suffix}`)) {
      env = suffix;
      filename = filename.slice(0, -(suffix.length + 1));
      break;
    }
  }

  // Reassemble segments
  segments.push(filename);

  // 3. Strip trailing "index"
  if (segments[segments.length - 1] === 'index') {
    segments.pop();
  }

  // 4. Remove route groups: (groupname)
  const filtered = segments.filter((s) => !s.startsWith('(') || !s.endsWith(')'));

  // 5. Convert dynamic segments
  const params: Array<string> = [];
  let catchAll = false;

  const converted = filtered.map((segment) => {
    // [...param] - catch-all with named param
    if (segment.startsWith('[...') && segment.endsWith(']')) {
      const paramName = segment.slice(4, -1);
      catchAll = true;
      if (paramName) {
        params.push(paramName);
        return `:${paramName}{.+}`;
      }
      return '*';
    }
    // [param] - single dynamic param
    if (segment.startsWith('[') && segment.endsWith(']')) {
      const paramName = segment.slice(1, -1);
      params.push(paramName);
      return `:${paramName}`;
    }
    return segment;
  });

  // 6. Build pattern with leading /
  const pattern = '/' + converted.join('/');

  return {
    pattern,
    methods: [], // populated by scanner via export detection
    params,
    catchAll,
    env,
    filePath,
  };
}

/**
 * Parse a route filename (relative to routes/) into a RouteDefinition.
 *
 * Rules (applied in order):
 * 1. Strip file extension (.ts, .tsx, .js, .jsx, .mts, .mjs)
 * 2. Check for env suffix (.dev, .prod) → strip and record
 * 3. Strip trailing "index" segment
 * 4. Remove route group directories: (groupname)
 * 5. Convert [param] → :param, [...param] → :param{.+}, [...] → *
 * 6. Prefix with /
 */
export function parseRouteFilename(relativePath: string): RouteDefinition {
  return parsePath(relativePath, false);
}

/** Parse a `.ws.*` route filename into a regular route definition. */
export function parseWebSocketFilename(relativePath: string): RouteDefinition {
  return parsePath(relativePath, true);
}

export function isRouteEnabledForEnvironment(
  route: Pick<RouteDefinition, 'env'>,
  environment?: RouteEnvironment,
): boolean {
  return environment === undefined || route.env === null || route.env === environment;
}

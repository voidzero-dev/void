import { join } from 'pathslash';
import { globSync } from 'tinyglobby';
import type { JobDefinition } from '../crons/scan.ts';
import { scanPages } from '../pages/scan.ts';
import type { PageScanResult } from '../pages/types.ts';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import type { QueueDefinition } from '../queues/scan.ts';
import { listRouteFiles } from '../shared/convention-files.ts';
import { detectHttpExports } from './detect-exports.ts';
import type { EmailHandlersScan } from './email.ts';
import {
  isRouteEnabledForEnvironment,
  parseRouteFilename,
  type RouteDefinition,
  type RouteEnvironment,
} from './parse-filename.ts';
import { isWebSocketPatternFile, type WebSocketRouteDefinition } from './websocket.ts';

export type ScanResult = {
  routes: Array<RouteDefinition>;
  websockets?: Array<WebSocketRouteDefinition>;
  middleware: Array<MiddlewareDefinition>;
  jobs: Array<JobDefinition>;
  queues: Array<QueueDefinition>;
  pages: PageScanResult;
  email?: EmailHandlersScan;
};

export type MiddlewareDefinition = {
  /** Numeric order prefix (e.g. 1 for "01.logger.ts") */
  order: number;
  /** Original filename */
  filePath: string;
};

function parseMiddlewareDefinitions(files: Array<string>): Array<MiddlewareDefinition> {
  return files
    .filter((f) => !f.startsWith('_'))
    .map((f) => {
      const basename = f.split('/').pop()!;
      const match = basename.match(/^(\d+)\./);
      return {
        order: match ? parseInt(match[1], 10) : Infinity,
        filePath: f,
      };
    })
    .sort((a, b) => a.order - b.order);
}

// Order by specificity (static < dynamic param < catch-all, depth-first); Hono resolves overlap by registration order.
function compareRouteSpecificity(a: RouteDefinition, b: RouteDefinition): number {
  if (a.catchAll !== b.catchAll) {
    return a.catchAll ? 1 : -1;
  }
  const aSegments = a.pattern.split('/');
  const bSegments = b.pattern.split('/');
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const aDynamic = aSegments[i].startsWith(':') || aSegments[i] === '*';
    const bDynamic = bSegments[i].startsWith(':') || bSegments[i] === '*';
    if (aDynamic !== bDynamic) {
      return aDynamic ? 1 : -1;
    }
    if (aSegments[i] !== bSegments[i]) {
      return aSegments[i].localeCompare(bSegments[i]);
    }
  }
  return aSegments.length - bSegments.length;
}

/** Add pages and HTTP methods to the inventories already resolved for this application phase. */
export async function scanRoutes(
  root: string,
  options: {
    output?: 'server' | 'static';
    paths: ProjectPaths;
    inventory: Omit<ScanResult, 'pages'>;
    checkPageRoutes?: boolean;
    /** Keep only pages for this environment. Unset keeps every page. */
    environment?: RouteEnvironment;
  },
): Promise<ScanResult> {
  const { paths, inventory } = options;
  const pages = await scanPages(root, {
    output: options.output,
    paths,
    checkRoutes: options.checkPageRoutes,
    environment: options.environment,
  });
  const routes = inventory.routes
    .map((route) => {
      const methods = detectHttpExports(join(paths.routesDir, route.filePath));
      // Hono runs the GET handler for HEAD requests and has no way to register a HEAD one.
      if (methods.includes('HEAD')) {
        throw new Error(
          `routes: '${route.filePath}' exports HEAD. HEAD requests are answered by the GET handler; remove the HEAD export.`,
        );
      }
      return { ...route, methods };
    })
    .sort(compareRouteSpecificity);
  return { ...inventory, routes, pages };
}

export function scanMiddlewareSync(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): Array<MiddlewareDefinition> {
  return parseMiddlewareDefinitions(globSync('**/*.{ts,mts,js,mjs}', { cwd: paths.middlewareDir }));
}

export function scanRoutePatternsSync(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
  environment?: RouteEnvironment,
): Array<RouteDefinition> {
  return listRouteFiles(paths.routesDir)
    .filter((f) => !isWebSocketPatternFile(f))
    .map((f) => parseRouteFilename(f))
    .filter((route) => isRouteEnabledForEnvironment(route, environment))
    .sort(compareRouteSpecificity);
}

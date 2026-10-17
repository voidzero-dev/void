import type { AssetConfig } from './cli/types.ts';
import type { NotFoundHandling } from './config.ts';
import type { RouteDefinition } from './router/parse-filename.ts';

export type AssetRoutingInputs = {
  isSsr: boolean;
  hasPages: boolean;
  hasApiRoutes?: boolean;
  hasDocumentRoutes: boolean;
  hasMiddleware: boolean;
  /** True only when a websocket route is outside /api and can own document paths. */
  hasWebSockets?: boolean;
  authEnabled?: boolean;
  liveEnabled?: boolean;
  /**
   * `routing.notFound` from the Void config. Overrides the INFERRED
   * `not_found_handling`. `run_worker_first`, `workerFirst` and
   * `apiWorkerFirst` are untouched, so which layer sees a request first never
   * changes. `workerSpaFallback` DOES follow it — see below.
   */
  notFound?: NotFoundHandling;
  /**
   * The image optimizer path (`images.path`) when the generated routes mount
   * it. SPA policies send it to the Worker first, so the SPA shell never
   * answers it.
   */
  imagePath?: string;
};

export type AssetRoutingPolicy = {
  assetConfig: AssetConfig;
  apiWorkerFirst: boolean;
  workerFirst: boolean;
  workerSpaFallback: boolean;
};

export function isApiRoutePattern(pattern: string): boolean {
  return pattern === '/api' || pattern.startsWith('/api/');
}

export function hasDocumentRoutes(routes: Array<Pick<RouteDefinition, 'pattern'>>): boolean {
  return routes.some((route) => !isApiRoutePattern(route.pattern));
}

export function hasApiRoutes(routes: Array<Pick<RouteDefinition, 'pattern'>>): boolean {
  return routes.some((route) => isApiRoutePattern(route.pattern));
}

/**
 * Returns true when browser document navigations must reach the worker before
 * a static asset fallback can serve HTML.
 */
export function workerOwnsHtmlRouting(inputs: AssetRoutingInputs): boolean {
  return (
    inputs.isSsr ||
    inputs.hasPages ||
    inputs.hasDocumentRoutes ||
    inputs.hasMiddleware ||
    inputs.hasWebSockets === true ||
    inputs.liveEnabled === true
  );
}

export function resolveAssetConfig(inputs: AssetRoutingInputs): AssetConfig {
  return resolveAssetRoutingPolicy(inputs).assetConfig;
}

// Void's reserved internal namespace (`/__void/ready`, `/__void/migrate/*`,
// etc.). These must reach the worker before CF Static Assets can serve the SPA
// shell — otherwise `not_found_handling: 'single-page-application'` returns
// index.html for GET /__void/migrate/capabilities and migration capability
// negotiation fails at deploy time. The worker-first (`/**`) branch already
// covers it; both SPA-fallback branches must list it explicitly, since a SPA
// can advertise migrations without API/auth routes (e.g. a cron/queue-only app
// with D1 migrations still emits manifest.migrations).
const VOID_INTERNAL_WORKER_FIRST = ['/__void', '/__void/*'];

export function resolveAssetRoutingPolicy(inputs: AssetRoutingInputs): AssetRoutingPolicy {
  const workerFirst = workerOwnsHtmlRouting(inputs);
  const apiWorkerFirst =
    !workerFirst && (inputs.hasApiRoutes === true || inputs.authEnabled === true);
  const internalWorkerFirst = inputs.imagePath
    ? [...VOID_INTERNAL_WORKER_FIRST, inputs.imagePath]
    : VOID_INTERNAL_WORKER_FIRST;
  const assetConfig: AssetConfig = workerFirst
    ? { not_found_handling: 'none', run_worker_first: ['/**'] }
    : apiWorkerFirst
      ? {
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api', '/api/*', ...internalWorkerFirst],
        }
      : {
          not_found_handling: 'single-page-application',
          run_worker_first: [...internalWorkerFirst],
        };
  // Explicit `routing.notFound` wins over the inferred value. Applied here (on
  // the inputs) rather than at the call sites so dev, build, and deploy can't
  // drift apart. `run_worker_first` is deliberately left as inferred.
  if (inputs.notFound !== undefined) {
    assetConfig.not_found_handling = inputs.notFound;
  }
  return {
    assetConfig,
    apiWorkerFirst,
    workerFirst,
    // The worker-side SPA fallback replaces the SPA behavior the inferred
    // `workerFirst` config gives up (`not_found_handling: 'none'` makes
    // `env.ASSETS.fetch()` return a bare 404 for an unmatched navigation).
    // `not_found_handling` still applies inside `env.ASSETS.fetch()`, so an
    // explicit `notFound` other than `single-page-application` must turn the
    // fallback off, or the shell would answer before that setting is consulted.
    workerSpaFallback:
      workerFirst &&
      !inputs.isSsr &&
      !inputs.hasPages &&
      (inputs.notFound === undefined || inputs.notFound === 'single-page-application'),
  };
}

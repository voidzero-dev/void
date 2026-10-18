import { isImageOptimizerEnabled, needsApplicationDatabase } from './application-features.ts';
import { findVoidAuthConfig } from './auth/config.ts';
import { getDatabaseDialect, resolveBindingNames, type VoidConfig } from './config.ts';
import { scanJobsSync } from './crons/scan.ts';
import { scanDurableObjectModules } from './durable/scan.ts';
import { detectVinextImagesOptimizer } from './inference/vinext-images.ts';
import type { InferredBindings } from './inference/walk.ts';
import { collectMigrations } from './migrations/collect.ts';
import { DEFAULT_IMAGES_BINDING } from './plugin-binding-utils.ts';
import { detectFramework, FRAMEWORK_SCAN_DIRS, inferProjectBindings } from './plugin-inference.ts';
import { resolveProjectPaths } from './project-paths.ts';
import { scanQueuesSync } from './queues/scan.ts';
import { scanEmailHandlersSync } from './router/email.ts';
import { isRouteEnabledForEnvironment, type RouteEnvironment } from './router/parse-filename.ts';
import { scanMiddlewareSync, scanRoutePatternsSync } from './router/scan.ts';
import { scanWebSocketRoutesSync } from './router/websocket.ts';
import { isSandboxEnabled } from './sandbox/config.ts';

export type ApplicationReasons = {
  database: Array<string>;
  kv: Array<string>;
  r2: Array<string>;
};

export type ApplicationAnalysis = {
  root: string;
  config: VoidConfig;
  environment?: RouteEnvironment;
  paths: ReturnType<typeof resolveProjectPaths>;
  framework: ReturnType<typeof detectFramework>;
  bindings: InferredBindings;
  authConfigPath: string | null;
  authEnabled: boolean;
  dialect: ReturnType<typeof getDatabaseDialect>;
  bindingNames: ReturnType<typeof resolveBindingNames>;
  needsDatabase: boolean;
  migrations: ReturnType<typeof collectMigrations>;
  jobs: ReturnType<typeof scanJobsSync>;
  queues: ReturnType<typeof scanQueuesSync>;
  websockets: ReturnType<typeof scanWebSocketRoutesSync>;
  allWebsockets: ReturnType<typeof scanWebSocketRoutesSync>;
  durableObjects: ReturnType<typeof scanDurableObjectModules>;
  email: ReturnType<typeof scanEmailHandlersSync>;
  routes: ReturnType<typeof scanRoutePatternsSync>;
  middleware: ReturnType<typeof scanMiddlewareSync>;
  reasons: ApplicationReasons;
};

/** Custom binding names, plus the binding vinext's optimizer reads unless configured. */
function resolveApplicationBindingNames(
  overrides: NonNullable<VoidConfig['inference']>['bindings'],
  vinextImages: { binding: string } | undefined,
): ReturnType<typeof resolveBindingNames> {
  const names = resolveBindingNames(overrides);
  if (
    vinextImages &&
    vinextImages.binding !== DEFAULT_IMAGES_BINDING &&
    typeof overrides?.images !== 'string'
  ) {
    return { ...names, images: vinextImages.binding };
  }
  return names;
}

/**
 * Discover application source features once for a consumer's environment.
 * Resource ids, generated provider configuration and migration history remain
 * the responsibility of the target consuming this analysis.
 */
export function analyzeApplicationSync(
  root: string,
  options: { config: VoidConfig; environment?: RouteEnvironment },
): ApplicationAnalysis {
  const { config, environment } = options;
  const paths = resolveProjectPaths(root, config);
  const framework = detectFramework(root);
  const scanDirs = config.inference?.scanDirs ?? (framework ? FRAMEWORK_SCAN_DIRS : undefined);
  const overrides = config.inference?.bindings;
  const inferred = inferProjectBindings(
    root,
    {
      paths,
      environment,
      bindings: overrides,
      imageOptimizer: isImageOptimizerEnabled(config, framework),
    },
    scanDirs,
  );
  // vinext serves `/_next/image` itself; its Cloudflare optimizer reads the Images binding.
  const vinextImages =
    framework?.name === 'vinext-app' || framework?.name === 'vinext-pages'
      ? detectVinextImagesOptimizer(root)
      : undefined;
  const authConfigPath = findVoidAuthConfig(root, paths);
  const authEnabled = inferred.needsAuth || authConfigPath !== null || config.auth !== undefined;
  const bindings = {
    ...inferred,
    needsAuth: authEnabled,
    needsSandbox: inferred.needsSandbox || isSandboxEnabled(config),
    ...(vinextImages && overrides?.images === undefined && { needsImages: true }),
  };
  const dialect = getDatabaseDialect(config);
  const migrations = collectMigrations(paths.migrationsDir);
  const jobs = scanJobsSync(paths.cronsDir);
  const queues = scanQueuesSync(paths.queuesDir);
  const allWebsockets = scanWebSocketRoutesSync(root, paths);
  const websockets = allWebsockets.filter((route) =>
    isRouteEnabledForEnvironment(route, environment),
  );
  // Typed durable modules currently use the root convention on every target.
  const durableObjects = scanDurableObjectModules(root);
  const email = scanEmailHandlersSync(paths.sourceRoot);
  const bindingReason = (
    key: 'db' | 'kv' | 'storage',
    label: string,
    inferredReason: string,
  ): string => (overrides?.[key] ? `inference.bindings.${key} enables ${label}` : inferredReason);
  const reasons: ApplicationReasons = {
    database: [],
    kv: bindings.needsKV ? [bindingReason('kv', 'KV', 'app uses env.KV')] : [],
    r2: bindings.needsR2 ? [bindingReason('storage', 'R2', 'app uses env.STORAGE (R2)')] : [],
  };
  const databaseName = dialect === 'sqlite' ? 'a D1 database' : 'a Hyperdrive database';
  if (bindings.needsD1) {
    reasons.database.push(
      bindingReason(
        'db',
        databaseName,
        dialect === 'sqlite' ? 'app uses env.DB (D1)' : 'app uses a database',
      ),
    );
  }
  if (authEnabled) {
    reasons.database.push(`auth requires ${databaseName}`);
  }
  if (migrations.length > 0) {
    reasons.database.push(`checked-in migrations need ${databaseName}`);
  }
  return {
    root,
    config,
    environment,
    paths,
    framework,
    bindings,
    authConfigPath,
    authEnabled,
    dialect,
    bindingNames: resolveApplicationBindingNames(overrides, vinextImages),
    needsDatabase: needsApplicationDatabase(bindings, migrations.length),
    migrations,
    jobs,
    queues,
    websockets,
    allWebsockets,
    durableObjects,
    email,
    routes: scanRoutePatternsSync(root, paths, environment),
    middleware: scanMiddlewareSync(root, paths),
    reasons,
  };
}

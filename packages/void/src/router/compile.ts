import { fileURLToPath } from 'node:url';
import { relative } from 'pathslash';
import type { VoidAuthProvider } from '../auth/providers.ts';
import type { DevRedirectRule, HeaderRule } from '../cli/types.ts';
import type { NotFoundHandling } from '../config.ts';
import type { MigrationPlanBundle } from '../migrations/plan.ts';
import { resolveLayoutIds } from '../pages/layout-resolution.ts';
import { generateQueueResolverSource } from '../queues/dispatch.ts';
import { INTERNAL_BINDING_EXACT_NAMES, INTERNAL_BINDING_PREFIXES } from '../runtime/env-raw.ts';
import { ASSET_EXTENSIONS } from '../runtime/routing-assets.ts';
import { DEFAULT_SANDBOX_CLASS_NAME } from '../sandbox/config.ts';
import type { ScanResult } from './scan.ts';

const FETCH_SERVER_PATH = fileURLToPath(import.meta.resolve('#self/runtime/fetch-server'));
const ROUTING_RUNTIME_PATH = fileURLToPath(import.meta.resolve('#self/runtime/routing'));

function pushDefaultErrorPageHelpers(lines: Array<string>, options: CompileOptions): void {
  lines.push(
    `const __errorRenderer = __createErrorRenderer(${JSON.stringify({ dev: options.dev === true, projectRoot: options.projectRoot, homeDir: options.homeDir })});`,
  );
  lines.push('app.onError(__errorRenderer.onError);');
}

export type AuthCompileOptions = {
  authRuntimePath: string;
  authConfigPath: string | null;
  authDatabasePath: string;
  authSchemaPath: string;
  dialect: 'sqlite' | 'postgresql' | 'mysql';
  providers: Array<VoidAuthProvider> | null;
};

export type CompileOptions = {
  /** Absolute path to the hono module entry */
  honoPath: string;
  /** Absolute path to `hono/route` from the same Hono copy as `honoPath` */
  honoRoutePath: string;
  /** Absolute path to the void/_env module */
  runtimeEnvPath: string;
  /** Absolute path to the project's `email/` directory; enables `__emailHandler`. */
  emailDir?: string;
  /** Absolute path to the project root */
  projectRoot: string;
  /** Absolute path to the current user's home directory */
  homeDir: string;
  /** Whether to inject React Fast Refresh preamble in dev SSR HTML. */
  reactRefresh: boolean;
  /**
   * Whether the generated route module is being compiled for the Vite dev
   * server. Also picks the manual trigger auth rule: dev accepts only
   * `x-void-dev-trigger`; every build uses the proxy token or build key.
   */
  dev?: boolean;
  /**
   * Token for local dev manual trigger endpoints (`x-void-dev-trigger`).
   * Stable for a dev-server process so tooling can print paste-ready curl
   * commands.
   */
  devTriggerToken?: string;
  /** Auth configuration (null = disabled) */
  auth: AuthCompileOptions | null;
  /** `node`/`bun`/`deno` target — omits executionCtx from ALS context */
  nodeTarget?: boolean;
  /** Managed Cloudflare build whose dispatch worker owns edge routing. */
  managedDispatch?: boolean;
  /** Absolute path to the binding handler module (for /__void/* native binding access) */
  bindingHandlerPath?: string;
  /** Absolute path to the migration handler module */
  migrationHandlerPath?: string;
  /** Bundled migration SQL entries */
  migrations?: Array<{ name: string; sql: string }>;
  /** Build-time migration execution plans for protocol v2 workers */
  migrationPlanBundle?: MigrationPlanBundle;
  /** Custom binding names configured through inference.bindings. */
  bindingNames?: { d1?: string; kv?: string; r2?: string };
  /** Header rules from routing.headers config. */
  headerRules?: Array<HeaderRule>;
  /** Pre-route redirects and rewrites. */
  redirectRules?: Array<DevRedirectRule>;
  /**
   * Post-asset fallback rules (plain `_redirects` 200 + `routing.fallbacks`).
   * Only fire when no route/SSR handler matched — emitted inside Hono's
   * `notFound` hook on runtimes without managed dispatch. Empty/undefined
   * skips the fallback middleware entirely.
   */
  fallbackRules?: Array<DevRedirectRule>;
  /** Resolved Vite build directory for hashed client assets. */
  assetsDir?: string;
  /** Explicit prerender paths from void.json routing.prerender */
  explicitPrerenderPaths?: Array<string>;
  /** Absolute path to the internal WebSocket runtime module */
  webSocketRuntimePath?: string;
  /** Absolute path to the internal Live runtime module */
  liveRuntimePath?: string;
  /** Whether the app uses void/live. */
  hasLive?: boolean;
  /** Removed WebSocket classes retained to preserve Durable Object storage. */
  webSocketTombstones?: Array<string>;
};

export type SsrCompileOptions = {
  /** Absolute path to src/main.ssr.ts(x) */
  serverEntryPath: string;
  /** Relative project path for src/main.client.ts(x), e.g. src/main.client.tsx */
  clientEntryRelativePath: string;
};

export type PagesCompileOptions = {
  /** Absolute path to pages/ directory */
  pagesDir: string;
  /** Pages directory relative to Vite root, e.g. "pages" — used for manifest key lookup */
  pagesDirRelative: string;
  /** Virtual module ID for the client entry (used for asset tags) */
  clientEntryId: string;
  /** Virtual module ID for the islands client entry (used for island asset tags) */
  islandClientEntryId?: string;
  /** Virtual module ID for the md plugin's client entry (script execution) */
  mdClientEntryId?: string;
  /** Head config from void.json */
  headConfig?: import('../pages/head.ts').HeadConfig;
};

/**
 * Generate the code for the virtual route table module (virtual:void-routes).
 * This module creates a Hono app with:
 * - Middleware registered via app.use()
 * - Routes registered with lazy-loaded handlers and auto-conversion
 */
export function compileRouteTable(
  scan: ScanResult,
  routesDir: string,
  middlewareDir: string,
  jobsDir: string,
  queuesDir: string,
  ssr: SsrCompileOptions | null,
  options: CompileOptions,
  pages: PagesCompileOptions | null = null,
  /**
   * Merged ISR revalidate config (number | Record<string, number>) baked into
   * the route table as `__VOID_ISR_REVALIDATE`. `undefined` (the default)
   * emits `= undefined;` so non-ISR builds are unaffected — the const is only
   * imported/used when the entry wires ISR.
   */
  mergedRevalidate?: number | Record<string, number>,
  /** Ordered page TTL policy used by native ISR before the flat fallback map. */
  isrPages?: ReadonlyArray<{ pattern: string; revalidate?: number }>,
  /** Raw object-form routing.revalidate config for inherit-eligible pages. */
  isrPathRevalidate?: Record<string, number>,
): string {
  const lines: Array<string> = [];
  const auth = options.auth;
  const webSockets = scan.websockets ?? [];
  const managedDispatch =
    options.nodeTarget !== true && options.dev !== true && options.managedDispatch === true;

  lines.push(`import { AsyncLocalStorage } from "node:async_hooks";`);
  lines.push(`import { Hono } from ${JSON.stringify(options.honoPath)};`);
  lines.push(
    `import { createRoutingRuntime as __createRoutingRuntime, createHttpRouteHandler as __createHttpRouteHandler, createErrorRenderer as __createErrorRenderer, createPageGetHandler as __createPageGetHandler, createPageMutationHandler as __createPageMutationHandler, createNamedActionMarker as __createNamedActionMarker, markRouteHandler as __markRouteHandler, createPagesFallback as __createPagesFallback, createModuleLoader as __createModuleLoader, createClientAssetTags as __createClientAssetTags, createManifestLoader as __createManifestLoader, createSsrFallback as __createSsrFallback, createAssetNotFound as __createAssetNotFound } from ${JSON.stringify(ROUTING_RUNTIME_PATH)};`,
  );
  if (options.nodeTarget) {
    lines.push(`const withRuntimeEnv = (_env, fn) => fn();`);
  } else {
    lines.push(`import { withRuntimeEnv } from ${JSON.stringify(options.runtimeEnvPath)};`);
  }

  if (auth) {
    const authImports = ['runVoidAuthMiddleware', 'handleVoidAuthRequest', 'runVoidAuthMigrations'];
    if (webSockets.length > 0) {
      authImports.push('resolveVoidAuthState as __resolveVoidAuthStateRuntime');
    }
    lines.push(
      `import { ${authImports.join(', ')} } from ${JSON.stringify(auth.authRuntimePath)};`,
    );
    lines.push(`import { __voidAuthDatabase } from ${JSON.stringify(auth.authDatabasePath)};`);
    lines.push(
      `import { migrationSchema as __voidAuthMigrationSchema } from ${JSON.stringify(auth.authSchemaPath)};`,
    );
    if (auth.authConfigPath) {
      lines.push(`import __voidAuthConfig from ${JSON.stringify(auth.authConfigPath)};`);
    }
  }
  if (
    (webSockets.length > 0 || options.webSocketTombstones?.length) &&
    options.webSocketRuntimePath
  ) {
    lines.push(
      `import { createWebSocketDurableObject as __createWebSocketDurableObject, createWebSocketTombstoneDurableObject as __createWebSocketTombstoneDurableObject, forwardWebSocketRequest as __forwardWebSocketRequest } from ${JSON.stringify(options.webSocketRuntimePath)};`,
    );
  }
  if (options.hasLive && options.liveRuntimePath) {
    lines.push(
      `import { createLiveDurableObject as __createLiveDurableObject } from ${JSON.stringify(options.liveRuntimePath)};`,
    );
  }
  lines.push('');

  // Generate eager imports for middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    const mw = scan.middleware[i];
    lines.push(`import middleware${i} from ${JSON.stringify(`${middlewareDir}/${mw.filePath}`)};`);
  }
  for (let i = 0; i < webSockets.length; i++) {
    const route = webSockets[i];
    lines.push(`import websocket${i} from ${JSON.stringify(`${routesDir}/${route.filePath}`)};`);
  }
  lines.push('');

  if (auth) {
    lines.push(
      `const __voidAuthOptions = { dialect: ${JSON.stringify(auth.dialect)}, providers: ${JSON.stringify(auth.providers)}, userConfig: ${auth.authConfigPath ? '__voidAuthConfig' : 'undefined'}, dev: ${JSON.stringify(options.dev === true)} };`,
    );
    if (webSockets.length > 0) {
      lines.push(
        'const __resolveVoidAuthState = (request, env, runtime) => __resolveVoidAuthStateRuntime(request, env, runtime, __voidAuthDatabase);',
      );
    }
    lines.push('');
  }

  lines.push(`const app = new Hono();`);
  // Route files may use dotted names (`feed.xml.ts`), so `c.rewrite()` must still reach them.
  const routePatterns: Array<string> = [];
  for (const r of scan.routes) {
    routePatterns.push(r.pattern);
  }
  if (pages && scan.pages.pages.length > 0) {
    for (const p of scan.pages.pages) {
      routePatterns.push(p.pattern);
    }
  }
  const usedExts = new Set<string>();
  for (const p of routePatterns) {
    const m = /\.([A-Za-z0-9]+)$/.exec(p);
    if (m) {
      usedExts.add(m[1]!.toLowerCase());
    }
  }
  const blockedExts = ASSET_EXTENSIONS.filter((e) => !usedExts.has(e));
  lines.push(
    `const __routingRuntime = __createRoutingRuntime(app, ${JSON.stringify({ dev: options.dev === true, nodeTarget: options.nodeTarget === true, managedDispatch, blockedAssetExtensions: blockedExts })});`,
  );
  lines.push('export const requestContext = __routingRuntime.requestContext;');
  lines.push('app.use(__routingRuntime.contextMiddleware);');
  lines.push('app.use(__routingRuntime.requestMiddleware);');
  lines.push('');

  // Edge routing middleware. Every target without managed platform dispatch
  // owns routing end-to-end, including native Cloudflare production builds.
  // Managed bundles omit it because dispatch applies the same rules first.
  const emitEdgeRules = !managedDispatch;
  const fallbackRulesJson = JSON.stringify(
    emitEdgeRules && options.fallbackRules?.length
      ? options.dev
        ? options.fallbackRules
        : stripOriginForProd(options.fallbackRules)
      : undefined,
  );
  if (emitEdgeRules && options.redirectRules?.length) {
    compileRoutingRulesMiddleware(lines, options.redirectRules, options.dev === true);
  }
  if (emitEdgeRules && options.headerRules?.length) {
    compileHeaderMiddleware(lines, options.headerRules);
  }

  // After routing rules, which ignore the action key as platform dispatch does,
  // and before auth and user middleware, so their c.redirect() drops it too.
  if (pages && scan.pages.pages.some((page) => page.methods.includes('actions'))) {
    lines.push(
      `import { matchedRoutes as __matchedRoutes } from ${JSON.stringify(options.honoRoutePath)};`,
    );
    lines.push('app.use(__createNamedActionMarker(__matchedRoutes));');
  }

  if (auth) {
    lines.push('app.use(async (c, next) => {');
    lines.push('  return runVoidAuthMiddleware(c, next, __voidAuthOptions, __voidAuthDatabase);');
    lines.push('});');
    lines.push('');
  }

  // Register user middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    lines.push(`app.use(middleware${i});`);
  }
  if (scan.middleware.length > 0) {
    lines.push('');
  }

  // WebSocket upgrades must enter the Hono app so global auth and user
  // middleware run before the Durable Object receives the request. Register
  // them before HTTP routes to preserve WebSocket priority when both route
  // kinds share a path, while non-upgrade requests continue through normally.
  for (let i = 0; i < webSockets.length; i++) {
    const route = webSockets[i];
    lines.push(`app.all(${JSON.stringify(route.pattern)}, async (c, next) => {`);
    lines.push(
      `  if (c.req.raw.headers.get("upgrade")?.toLowerCase() !== "websocket") return next();`,
    );
    lines.push(
      `  return __forwardWebSocketRequest(c.req.raw, c.env, __voidWebSocketRoutes[${i}]);`,
    );
    lines.push('});');
  }
  if (webSockets.length > 0) {
    lines.push('');
  }

  if (auth) {
    lines.push('app.all("/api/auth", __markRouteHandler(async (c) => {');
    lines.push('  return handleVoidAuthRequest(c, __voidAuthOptions, __voidAuthDatabase);');
    lines.push('}));');
    lines.push('');
    lines.push('app.all("/api/auth/*", __markRouteHandler(async (c) => {');
    lines.push('  return handleVoidAuthRequest(c, __voidAuthOptions, __voidAuthDatabase);');
    lines.push('}));');
    lines.push('');
  }

  // Register routes with lazy-loaded handlers (shared loader per file)
  const seenFiles = new Set<string>();
  for (const route of scan.routes) {
    const filePath = `${routesDir}/${route.filePath}`;
    const loaderName = `_load_${route.filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    if (!seenFiles.has(route.filePath)) {
      seenFiles.add(route.filePath);
      lines.push(
        `const ${loaderName} = __createModuleLoader(() => import(${JSON.stringify(filePath)}), ${JSON.stringify(options.dev !== true)});`,
      );
    }

    if (route.methods.length === 0) {
      // No recognized HTTP exports — register as all()
      lines.push(
        `app.all(${JSON.stringify(route.pattern)}, __createHttpRouteHandler(${loaderName}, "default"));`,
      );
    } else {
      for (const method of route.methods) {
        const honoMethod = method.toLowerCase();
        lines.push(
          `app.${honoMethod}(${JSON.stringify(route.pattern)}, __createHttpRouteHandler(${loaderName}, ${JSON.stringify(method)}));`,
        );
      }
    }
  }
  lines.push('');

  if (webSockets.length > 0) {
    for (let i = 0; i < webSockets.length; i++) {
      const route = webSockets[i];
      lines.push(
        `export const ${route.className} = __createWebSocketDurableObject(websocket${i}, ${JSON.stringify(
          {
            pattern: route.pattern,
            params: route.params,
            className: route.className,
            bindingName: route.bindingName,
            ...(route.name !== undefined && { name: route.name }),
          },
        )}, ${auth ? '__voidAuthOptions' : 'undefined'}, ${auth ? '__resolveVoidAuthState' : 'undefined'});`,
      );
    }
    lines.push('');
    lines.push(
      `const __voidWebSocketRoutes = ${JSON.stringify(
        webSockets.map((route) => ({
          pattern: route.pattern,
          params: route.params,
          className: route.className,
          bindingName: route.bindingName,
          ...(route.name !== undefined && { name: route.name }),
        })),
      )};`,
    );
    lines.push('');
  }
  for (let i = 0; i < webSockets.length; i++) {
    lines.push(`__voidWebSocketRoutes[${i}].key = websocket${i}.key;`);
  }
  for (const className of options.webSocketTombstones ?? []) {
    lines.push(
      `export const ${className} = __createWebSocketTombstoneDurableObject(${JSON.stringify(className)});`,
    );
  }
  if (options.webSocketTombstones?.length) {
    lines.push('');
  }

  if (options.hasLive) {
    lines.push('export const VoidLiveStreamDurableObject = __createLiveDurableObject();');
    lines.push('');
  }

  // Pages mode — generate page route handlers
  if (pages && scan.pages.pages.length > 0) {
    compilePageRoutes(lines, scan, pages, options);
  }

  // Ordinary HTTP hooks are fallbacks for WebSocket paths. Explicit API and
  // Pages handlers win for their methods; upgrades were forwarded above.
  for (let i = 0; i < webSockets.length; i++) {
    lines.push(
      `app.all(${JSON.stringify(webSockets[i].pattern)}, __markRouteHandler((c) => __forwardWebSocketRequest(c.req.raw, c.env, __voidWebSocketRoutes[${i}])));`,
    );
  }
  if (webSockets.length > 0) {
    lines.push('');
  }

  if (pages && scan.pages.pages.length > 0) {
    lines.push(
      `app.notFound(__createPagesFallback({ routing: __routingRuntime, errors: __errorRenderer, assetsDir: ${JSON.stringify(options.assetsDir)}, fallbackRules: ${fallbackRulesJson} }));`,
    );
  }

  compilePrerenderCollector(lines, scan, ssr, options);

  if (ssr) {
    lines.push(
      `const getClientAssetTags = __createClientAssetTags(${JSON.stringify({ entryId: ssr.clientEntryRelativePath, entryUrl: '/' + ssr.clientEntryRelativePath, kind: 'ssr', dev: options.dev === true, reactRefresh: options.reactRefresh })});`,
    );
    lines.push(
      `app.notFound(__createSsrFallback({ routing: __routingRuntime, nodeTarget: ${JSON.stringify(options.nodeTarget === true)}, assetsDir: ${JSON.stringify(options.assetsDir)}, fallbackRules: ${fallbackRulesJson}, load: () => import(${JSON.stringify(ssr.serverEntryPath)}), assets: getClientAssetTags }));`,
    );
  } else if (
    emitEdgeRules &&
    (options.fallbackRules?.length ||
      options.redirectRules?.some((rule) => rule.status === 200) ||
      (!options.nodeTarget && options.headerRules?.length)) &&
    !(pages && scan.pages.pages.length > 0)
  ) {
    lines.push(
      `app.notFound(__createAssetNotFound({ routing: __routingRuntime, nodeTarget: ${JSON.stringify(options.nodeTarget === true)}, assetsDir: ${JSON.stringify(options.assetsDir)}, fallbackRules: ${fallbackRulesJson} }));`,
    );
  }

  if (scan.jobs.length > 0) {
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      lines.push(`const job${i}Crons = ${JSON.stringify(job.crons)};`);
    }
    lines.push('');
    // Workers log capture keeps only an error's own name, message and stack (not
    // AggregateError.errors or cause), so each job logs its own error, with the job file
    // and cron, as soon as it fails.
    lines.push('export async function scheduled(controller, env, ctx) {');
    lines.push('  const run = async (job, loadJob) => {');
    lines.push('    try {');
    lines.push('      const mod = await loadJob();');
    lines.push(
      "      if (typeof mod.default === 'function') await mod.default(controller, env, ctx);",
    );
    lines.push('    } catch (error) {');
    lines.push(
      '      console.error(`[void] Scheduled job ${job} failed for cron "${controller.cron}":`, error);',
    );
    lines.push('      return { job, error };');
    lines.push('    }');
    lines.push('  };');
    lines.push('  const tasks = [];');
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      const filePath = JSON.stringify(`${jobsDir}/${job.filePath}`);
      const label = JSON.stringify(relative(options.projectRoot, `${jobsDir}/${job.filePath}`));
      lines.push(
        `  if (job${i}Crons.includes(controller.cron)) tasks.push(run(${label}, () => import(${filePath})));`,
      );
    }
    lines.push('  const failures = (await Promise.all(tasks)).filter(Boolean);');
    lines.push('  if (failures.length) {');
    lines.push(
      '    throw new AggregateError(failures.map((failure) => failure.error), `Scheduled jobs failed: ${failures.map((failure) => failure.job).join(", ")}`);',
    );
    lines.push('  }');
    lines.push('}');
    lines.push('');
  } else {
    lines.push('export async function scheduled() {}');
    lines.push('');
  }

  if (scan.jobs.length > 0 || scan.queues.length > 0) {
    lines.push('function __voidTriggerUnauthorized(c) {');
    lines.push('  const __token = c.req.header("x-void-internal");');
    lines.push('  const __expected = __getRawEnv()?.__VOID_PROXY_TOKEN;');
    lines.push('  const __devToken = c.req.header("x-void-dev-trigger");');
    lines.push(
      '  return __VOID_SERVE ? __devToken !== __VOID_DEV_TRIGGER_TOKEN : __expected ? __token !== __expected : __token !== __VOID_BUILD_KEY;',
    );
    lines.push('}');
    lines.push('');
  }

  if (scan.jobs.length > 0) {
    lines.push('const __scheduledHandler = async (c) => {');
    lines.push(
      '  if (__voidTriggerUnauthorized(c)) return c.json({ error: "unauthorized" }, 401);',
    );
    lines.push('  const { cron, scheduledTime } = await c.req.json();');
    lines.push('  const controller = { cron, scheduledTime, noRetry() {} };');
    lines.push('  await scheduled(controller, c.env, c.executionCtx);');
    lines.push('  return c.json({ ok: true });');
    lines.push('};');
    lines.push('app.post("/__void/scheduled", __markRouteHandler(__scheduledHandler));');
    lines.push('');
  }

  if (scan.queues.length > 0) {
    lines.push(generateQueueResolverSource(scan.queues.map((queue) => queue.name)));
    lines.push('');
    // Queue dispatch as a standalone function — called directly by native queue handler
    // and via the authenticated HTTP route. No global mutable state needed.
    lines.push('export async function __processQueue(payload, env) {');
    lines.push('  const queueSuffix = payload.queue;');
    lines.push('  const __queueIndex = __resolveQueueIndex(queueSuffix);');
    lines.push('  if (__queueIndex === -1) {');
    lines.push(
      '    return { ok: false, error: `No unambiguous queue handler matches "${String(queueSuffix)}"` };',
    );
    lines.push('  }');
    lines.push('  const __decisions = new Map();');
    lines.push('  function __wrapMsg(m) {');
    lines.push('    let decided = false;');
    lines.push('    return {');
    lines.push(
      '      id: m.id, timestamp: new Date(m.timestamp), body: m.body, attempts: m.attempts,',
    );
    lines.push(
      '      ack() { if (!decided) { decided = true; __decisions.set(m.id, { action: "ack" }); } },',
    );
    lines.push(
      '      retry(opts) { if (!decided) { decided = true; __decisions.set(m.id, { action: "retry", ...(opts?.delaySeconds != null ? { delaySeconds: opts.delaySeconds } : {}) }); } },',
    );
    lines.push('    };');
    lines.push('  }');
    lines.push('  const __msgs = payload.messages.map(__wrapMsg);');
    lines.push('  const batch = {');
    lines.push('    queue: queueSuffix,');
    lines.push('    messages: __msgs,');
    lines.push('    ackAll() { for (const m of __msgs) m.ack(); },');
    lines.push('    retryAll(opts) { for (const m of __msgs) m.retry(opts); },');
    lines.push('  };');
    lines.push('  let __ok = true;');
    lines.push('  try {');
    lines.push('    switch (__queueIndex) {');
    for (let i = 0; i < scan.queues.length; i++) {
      const q = scan.queues[i];
      lines.push(`      case ${i}: {`);
      lines.push(
        `        const mod = await import(${JSON.stringify(`${queuesDir}/${q.filePath}`)});`,
      );
      lines.push("        if (typeof mod.default === 'function') await mod.default(batch, env);");
      lines.push('        break;');
      lines.push('      }');
    }
    lines.push('    }');
    lines.push('  } catch { __ok = false; }');
    lines.push(
      '  return { ok: __ok, ...(__decisions.size > 0 ? { decisions: Object.fromEntries(__decisions) } : {}) };',
    );
    lines.push('}');
    lines.push('');

    lines.push('const __queueHandler = async (c) => {');
    lines.push(
      '  if (__voidTriggerUnauthorized(c)) return c.json({ error: "unauthorized" }, 401);',
    );
    lines.push('  const payload = await c.req.json();');
    lines.push('  const result = await __processQueue(payload, c.env);');
    lines.push('  return c.json(result);');
    lines.push('};');
    lines.push('app.post("/__void/queue", __markRouteHandler(__queueHandler));');
    lines.push('');
  }

  // Inbound email: the first recipient pattern in scanner order wins, then `_default`.
  const email = scan.email;
  const emailDir = options.emailDir;
  if (emailDir && email && (email.addresses.length > 0 || email.defaultHandler)) {
    if (email.defaultHandler) {
      lines.push(
        `const __emailDefault = () => import(${JSON.stringify(`${emailDir}/${email.defaultHandler}`)});`,
      );
    }
    for (let i = 0; i < email.addresses.length; i++) {
      const def = email.addresses[i];
      lines.push(
        `const __emailAddr${i} = () => import(${JSON.stringify(`${emailDir}/${def.filePath}`)});`,
      );
    }
    if (email.addresses.length > 0) {
      lines.push('const __emailPatterns = [');
      for (let i = 0; i < email.addresses.length; i++) {
        const def = email.addresses[i];
        const path = `${emailDir}/${def.filePath}`;
        lines.push(
          `  { re: new RegExp(${JSON.stringify(def.pattern.regexSource)}, "i"), params: ${JSON.stringify(def.pattern.paramNames)}, path: ${JSON.stringify(path)}, load: __emailAddr${i} },`,
        );
      }
      lines.push('];');
    }
    lines.push('');
    lines.push('export async function __emailHandler(message, env, ctx, __opts) {');
    // Match the wire recipient: `createMessageProxy` already stripped the slug from `message.to`.
    // Keep the case; patterns use the `i` flag so captured tags stay intact.
    lines.push('  const __platformTo = message ? message.__voidPlatformTo : undefined;');
    lines.push('  const __to = String((__platformTo ?? (message && message.to)) || "");');
    lines.push('  const __localFull = __to.split("@")[0] || "";');
    // With a slug configured, `<slug>[+<tag>]` routes on the tag; a bare `<slug>@` has an empty tag.
    lines.push('  let __local = __localFull;');
    lines.push('  if (__opts && __opts.slug) {');
    lines.push('    const __plus = __localFull.indexOf("+");');
    lines.push('    __local = __plus === -1 ? "" : __localFull.slice(__plus + 1);');
    lines.push('  }');
    if (email.addresses.length > 0) {
      lines.push('  for (const __p of __emailPatterns) {');
      lines.push('    const __m = __p.re.exec(__local);');
      lines.push('    if (!__m) continue;');
      lines.push('    const __params = {};');
      lines.push('    for (let __i = 0; __i < __p.params.length; __i++) {');
      lines.push('      __params[__p.params[__i]] = __m[__i + 1];');
      lines.push('    }');
      lines.push('    const __mod = await __p.load();');
      lines.push('    if (typeof __mod.default !== "function") {');
      lines.push(
        '      throw new Error("email handler at " + __p.path + " has no default export");',
      );
      lines.push('    }');
      lines.push('    return await __mod.default(message, env, ctx, { params: __params });');
      lines.push('  }');
    }
    if (email.defaultHandler) {
      const defaultPath = `${emailDir}/${email.defaultHandler}`;
      lines.push('  const __dmod = await __emailDefault();');
      lines.push('  if (typeof __dmod.default !== "function") {');
      lines.push(
        `    throw new Error("email handler at " + ${JSON.stringify(defaultPath)} + " has no default export");`,
      );
      lines.push('  }');
      lines.push('  return await __dmod.default(message, env, ctx, { params: {} });');
    } else {
      // Reject unmatched mail so the sender gets a bounce instead of silent loss.
      lines.push('  if (typeof message.setReject === "function") {');
      lines.push(
        '    message.setReject("no handler matched recipient \\"" + __to + "\\" — add email/_default.ts to handle unmatched mail");',
      );
      lines.push('  }');
    }
    lines.push('}');
    lines.push('');
  }

  // /__void/migrate handler — runs bundled DB + auth migrations in-worker
  if (options.migrationHandlerPath && (options.migrations?.length || auth)) {
    const d1BindingName = options.bindingNames?.d1;
    lines.push(
      `import { createMigrationHandler as __createMigrationHandler } from ${JSON.stringify(options.migrationHandlerPath)};`,
    );
    lines.push(`const __migrations = ${JSON.stringify(options.migrations)};`);
    lines.push(`const __migrationPlanBundle = ${JSON.stringify(options.migrationPlanBundle)};`);
    if (d1BindingName) {
      lines.push(
        `function __voidGetMigrationEnv() {
  const env = __getRawEnv();
  if (!env || env[${JSON.stringify(d1BindingName)}] == null) return env;
  return { ...env, DB: env[${JSON.stringify(d1BindingName)}] };
}`,
      );
    } else {
      lines.push('function __voidGetMigrationEnv() { return __getRawEnv(); }');
    }
    lines.push(
      'function __voidCreateMigrationRequestHandler(includeAuthMigrations, includePlanBundle) {',
    );
    lines.push('  return __createMigrationHandler(');
    lines.push('    __voidGetMigrationEnv(),');
    lines.push('    __migrations,');
    if (auth) {
      lines.push(
        '    includeAuthMigrations ? () => runVoidAuthMigrations(__voidGetMigrationEnv(), __voidAuthOptions, __voidAuthMigrationSchema) : undefined,',
      );
    } else {
      lines.push('    undefined,');
    }
    lines.push('    includePlanBundle ? __migrationPlanBundle : undefined,');
    lines.push('  );');
    lines.push('}');
    lines.push('export async function __voidHandleInternalRoute(request) {');
    lines.push('  const url = new URL(request.url);');
    lines.push('  if (request.method === "POST" && url.pathname === "/__void/migrate") {');
    lines.push(
      `    return __voidCreateMigrationRequestHandler(${auth ? 'true' : 'false'}, false)(request);`,
    );
    lines.push('  }');
    lines.push(
      '  if (request.method === "GET" && url.pathname === "/__void/migrate/capabilities") {',
    );
    lines.push(
      `    return __voidCreateMigrationRequestHandler(${auth ? 'true' : 'false'}, true)(request);`,
    );
    lines.push('  }');
    lines.push('  if (request.method === "POST" && url.pathname === "/__void/migrate/app") {');
    lines.push('    return __voidCreateMigrationRequestHandler(false, true)(request);');
    lines.push('  }');
    lines.push(
      '  if (request.method === "GET" && url.pathname.startsWith("/__void/migrate/app/attempt/")) {',
    );
    lines.push('    return __voidCreateMigrationRequestHandler(false, true)(request);');
    lines.push('  }');
    if (auth) {
      lines.push('  if (request.method === "POST" && url.pathname === "/__void/migrate/auth") {');
      lines.push('    return __voidCreateMigrationRequestHandler(true, true)(request);');
      lines.push('  }');
    }
    lines.push('  return null;');
    lines.push('}');
    lines.push(
      `app.post("/__void/migrate", __markRouteHandler((c) => __voidCreateMigrationRequestHandler(${auth ? 'true' : 'false'}, false)(c.req.raw)));`,
    );
    lines.push(
      `app.get("/__void/migrate/capabilities", __markRouteHandler((c) => __voidCreateMigrationRequestHandler(${auth ? 'true' : 'false'}, true)(c.req.raw)));`,
    );
    lines.push(
      'app.post("/__void/migrate/app", __markRouteHandler((c) => __voidCreateMigrationRequestHandler(false, true)(c.req.raw)));',
    );
    lines.push(
      'app.get("/__void/migrate/app/attempt/:attemptId", __markRouteHandler((c) => __voidCreateMigrationRequestHandler(false, true)(c.req.raw)));',
    );
    if (auth) {
      lines.push(
        'app.post("/__void/migrate/auth", __markRouteHandler((c) => __voidCreateMigrationRequestHandler(true, true)(c.req.raw)));',
      );
    }
    lines.push('');
  } else {
    lines.push('export async function __voidHandleInternalRoute() { return null; }');
    lines.push('');
  }

  // /__void/* handler — native binding access via WfP dispatch (always injected for CF targets)
  if (options.bindingHandlerPath) {
    lines.push(
      `import { createBindingHandler as __createBindingHandler } from ${JSON.stringify(options.bindingHandlerPath)};`,
    );
    lines.push('let __voidBindingApp;');
    lines.push('app.all("/__void/*", __markRouteHandler(async (c) => {');
    lines.push(
      '  if (!__voidBindingApp) __voidBindingApp = __createBindingHandler(__getRawEnv());',
    );
    lines.push('  const url = new URL(c.req.url);');
    lines.push('  url.pathname = url.pathname.slice(7);');
    lines.push('  return __voidBindingApp.fetch(new Request(url.toString(), c.req.raw));');
    lines.push('}));');
    lines.push('');
  }

  // Request-scoped raw env — safe for concurrent requests (uses ALS, not a module global).
  // The worker entry wraps each request in __withRawEnv(env, fn). Internal route handlers
  // read it via __getRawEnv() which returns the per-request value from AsyncLocalStorage.
  lines.push('const __rawEnvStore = new AsyncLocalStorage();');
  lines.push('export function __withRawEnv(env, fn) { return __rawEnvStore.run(env, fn); }');
  lines.push('function __getRawEnv() { return __rawEnvStore.getStore(); }');
  // Build-time key for internal route auth when __VOID_PROXY_TOKEN is absent.
  // Embedded in the compiled route table — only same-build callers know it.
  lines.push(`export const __VOID_BUILD_KEY = ${JSON.stringify(crypto.randomUUID())};`);
  lines.push(
    `export const __VOID_DEV_TRIGGER_TOKEN = ${JSON.stringify(options.devTriggerToken ?? crypto.randomUUID())};`,
  );
  // Manual trigger auth (`/__void/scheduled`, `/__void/queue`) is fixed when the
  // module is compiled, not read from `import.meta.env.DEV`: a build with
  // NODE_ENV=development still has DEV=true, and must keep the proxy-token /
  // build-key rule. Only the Vite dev server compiles with `dev: true`.
  lines.push(`const __VOID_SERVE = ${JSON.stringify(options.dev === true)};`);
  // Baked ISR policy. The ordered page table preserves explicit opt-outs and
  // object-config inheritance before the flat fallback map is consulted.
  // `__VOID_ISR_DEPLOYMENT_ID` MUST be a COMPILE-TIME LITERAL —
  // stringified here at build time exactly like `__VOID_BUILD_KEY` above — so every
  // isolate of a deployment shares one id (edge-cache keys, KV keys, and the
  // `revalidate()` purge path must all agree). A runtime `crypto.randomUUID()` in the
  // emitted source would mint a fresh id per isolate and break cache reads + purge.
  lines.push(`export const __VOID_ISR_REVALIDATE = ${JSON.stringify(mergedRevalidate)};`);
  lines.push(`export const __VOID_ISR_PAGES = ${JSON.stringify(isrPages)};`);
  lines.push(`export const __VOID_ISR_PATH_REVALIDATE = ${JSON.stringify(isrPathRevalidate)};`);
  lines.push(`export const __VOID_ISR_DEPLOYMENT_ID = ${JSON.stringify(crypto.randomUUID())};`);
  lines.push('');
  lines.push(`export default app;`);

  return lines.join('\n');
}

function compilePrerenderCollector(
  lines: Array<string>,
  scan: ScanResult,
  ssr: SsrCompileOptions | null,
  options: CompileOptions,
): void {
  const staticPaths = scan.pages.pages
    .filter((page) => page.shouldPrerender && page.params.length === 0 && !page.catchAll)
    .map((page) => page.pattern);
  const dynamicPages = scan.pages.pages.filter(
    (page) =>
      page.shouldPrerender &&
      page.hasGetPrerenderPaths &&
      (page.params.length > 0 || page.catchAll),
  );
  const explicitPaths = options.explicitPrerenderPaths ?? [];

  lines.push(`function __voidBuildPrerenderPath(pattern, params) {`);
  lines.push(`  let path = pattern;`);
  lines.push(`  for (const [key, value] of Object.entries(params)) {`);
  lines.push(`    path = path.replace(":" + key + "{.+}", value);`);
  lines.push(`    path = path.replace(":" + key, value);`);
  lines.push(`  }`);
  lines.push(`  return path;`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export async function __voidCollectPrerenderPaths(request, env, ctx) {`);
  lines.push(`  return withRuntimeEnv(env, async () => {`);
  if (options.nodeTarget) {
    lines.push(`    return requestContext.run({ request }, async () => {`);
  } else {
    lines.push(`    return requestContext.run({ request, executionCtx: ctx }, async () => {`);
  }
  lines.push(`      const paths = [];`);

  for (const path of staticPaths) {
    lines.push(`      paths.push(${JSON.stringify(path)});`);
  }

  for (const page of dynamicPages) {
    const loaderName = `_pload_${page.componentId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    lines.push(`      {`);
    lines.push(`        const mod = await ${loaderName}();`);
    lines.push(`        if (typeof mod.getPrerenderPaths === "function") {`);
    lines.push(`          const paramSets = await mod.getPrerenderPaths();`);
    lines.push(`          if (Array.isArray(paramSets)) {`);
    lines.push(`            for (const params of paramSets) {`);
    lines.push(
      `              paths.push(__voidBuildPrerenderPath(${JSON.stringify(page.pattern)}, params));`,
    );
    lines.push(`            }`);
    lines.push(`          }`);
    lines.push(`        }`);
    lines.push(`      }`);
  }

  if (ssr) {
    lines.push(`      {`);
    lines.push(`        const mod = await import(${JSON.stringify(ssr.serverEntryPath)});`);
    lines.push(`        if (typeof mod.getPrerenderPaths === "function") {`);
    lines.push(`          const ssrPaths = await mod.getPrerenderPaths();`);
    lines.push(`          if (Array.isArray(ssrPaths)) {`);
    lines.push(`            for (const path of ssrPaths) {`);
    lines.push(`              if (typeof path === "string") paths.push(path);`);
    lines.push(`            }`);
    lines.push(`          }`);
    lines.push(`        }`);
    lines.push(`      }`);
  }

  for (const path of explicitPaths) {
    lines.push(`      paths.push(${JSON.stringify(path)});`);
  }

  lines.push(`      return [...new Set(paths)];`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push('');
}

function compilePageRoutes(
  lines: Array<string>,
  scan: ScanResult,
  pages: PagesCompileOptions,
  options: CompileOptions,
): void {
  // Import protocol helpers and renderer
  lines.push(`import { renderPage } from "virtual:void-pages-renderer";`);
  if (options.dev) {
    lines.push(`import { getVoidPagesDevCss } from "virtual:void-pages-dev-assets";`);
  }

  // Import island renderer if any island pages exist
  const hasIslandPages = scan.pages.pages.some((p) => p.renderMode === 'island');
  if (hasIslandPages) {
    lines.push(`import { renderIslandPage } from "virtual:void-islands-renderer";`);
  }
  lines.push('');
  // Emit head config constant from void.json
  lines.push(`const __voidHeadConfig = ${JSON.stringify(pages.headConfig ?? null)};`);
  lines.push('');
  pushDefaultErrorPageHelpers(lines, options);

  // Build manifest-key mapping for each page and its layout chain
  // so CSS collection can be scoped to the active route only
  const relPagesDir = pages.pagesDirRelative;
  const pageCssKeys: Record<string, Array<string>> = {};
  const pageDevRootPhases: Record<string, Array<Array<string>>> = {};
  const projectRoot = options.projectRoot;
  const toDevRootUrl = (absolutePath: string): string =>
    '/' + absolutePath.replaceAll('\\', '/').slice(projectRoot.replaceAll('\\', '/').length + 1);
  const virtualDevUrl = (id: string): string => '/@id/__x00__' + id;
  for (const page of scan.pages.pages) {
    const keys: Array<string> = [];
    const routeRootPhases: Array<Array<string>> = [
      [
        virtualDevUrl(
          page.island ? (pages.islandClientEntryId ?? pages.clientEntryId) : pages.clientEntryId,
        ),
      ],
    ];
    if (page.island && pages.mdClientEntryId) {
      routeRootPhases[0].push(virtualDevUrl(pages.mdClientEntryId));
    }
    const layoutIds = resolveLayoutIds(page, scan.pages.layouts, scan.pages.namedLayouts);
    const layoutRoots: Array<string> = [];
    for (const layoutId of layoutIds) {
      // Map layout IDs back to file paths
      const layout = scan.pages.layouts.find(
        (l) => (l.directory ? `${l.directory}/layout` : 'layout') === layoutId,
      );
      if (layout) {
        keys.push(`${relPagesDir}/${layout.filePath}`);
        layoutRoots.push(toDevRootUrl(`${pages.pagesDir}/${layout.filePath}`));
        continue;
      }
      const named = scan.pages.namedLayouts.find((nl) => {
        const id = nl.directory ? `${nl.directory}/_layouts/${nl.name}` : `_layouts/${nl.name}`;
        return id === layoutId;
      });
      if (named) {
        keys.push(`${relPagesDir}/${named.filePath}`);
        layoutRoots.push(toDevRootUrl(`${pages.pagesDir}/${named.filePath}`));
      }
    }
    keys.push(`${relPagesDir}/${page.componentPath}`);
    routeRootPhases.push(layoutRoots);
    routeRootPhases.push([toDevRootUrl(`${pages.pagesDir}/${page.componentPath}`)]);
    pageCssKeys[page.componentId] = keys;
    pageDevRootPhases[page.componentId] = routeRootPhases.filter((phase) => phase.length > 0);
  }
  lines.push('const __loadPagesManifest = __createManifestLoader();');
  const assetMetadata = {
    pageCssKeys,
    devRootPhases: options.dev ? pageDevRootPhases : undefined,
    dev: options.dev === true,
  };
  const devCssOption = options.dev ? ', devCss: getVoidPagesDevCss' : '';
  lines.push(
    `const getPagesAssetTags = __createClientAssetTags({ ...${JSON.stringify({ ...assetMetadata, entryId: pages.clientEntryId, entryUrl: '/@id/__x00__' + pages.clientEntryId, kind: 'pages' })}${devCssOption} }, __loadPagesManifest);`,
  );
  if (hasIslandPages && pages.islandClientEntryId) {
    lines.push(
      `const getIslandsAssetTags = __createClientAssetTags({ ...${JSON.stringify({ ...assetMetadata, entryId: pages.islandClientEntryId, entryUrl: '/@id/__x00__' + pages.islandClientEntryId, extraEntryId: pages.mdClientEntryId, extraEntryUrl: pages.mdClientEntryId ? '/@id/__x00__' + pages.mdClientEntryId : undefined, kind: 'islands' })}${devCssOption} }, __loadPagesManifest);`,
    );
  }

  // Generate lazy loaders and route registrations for each page
  const seenServerFiles = new Set<string>();
  for (const page of scan.pages.pages) {
    const safeId = page.componentId.replace(/[^a-zA-Z0-9]/g, '_');

    // Determine server module path
    let serverImportPath: string | null = null;
    if (page.serverPath) {
      serverImportPath = `${pages.pagesDir}/${page.serverPath}`;
    }

    // Generate lazy loader for server module (if any)
    if (serverImportPath && !seenServerFiles.has(serverImportPath)) {
      seenServerFiles.add(serverImportPath);
      const loaderName = `_pload_${safeId}`;
      lines.push(
        `const ${loaderName} = __createModuleLoader(() => import(${JSON.stringify(serverImportPath)}));`,
      );
    }

    // Generate inline head function for markdown pages without .server.ts
    let mdHeadRef: string | null = null;
    if (!serverImportPath && page.metadata && (page.metadata.title || page.metadata.description)) {
      const headObj: Record<string, unknown> = {};
      if (page.metadata.title) {
        headObj.title = page.metadata.title;
      }
      if (page.metadata.description) {
        headObj.meta = [{ name: 'description', content: page.metadata.description }];
      }
      const headVarName = `__mdHead_${safeId}`;
      lines.push(`const ${headVarName} = () => (${JSON.stringify(headObj)});`);
      mdHeadRef = headVarName;
    }

    // Choose renderer and asset tags based on normalized render mode
    const renderer = page.renderMode === 'island' ? 'renderIslandPage' : 'renderPage';
    const assetTags =
      page.renderMode === 'island' && pages.islandClientEntryId
        ? 'getIslandsAssetTags'
        : 'getPagesAssetTags';
    const routeOptions = `{ ${serverImportPath ? 'load: _pload_' + safeId + ', ' : ''}${mdHeadRef ? 'head: ' + mdHeadRef + ', ' : ''}componentId: ${JSON.stringify(page.componentId)}, render: ${renderer}, assets: ${assetTags}, headConfig: __voidHeadConfig, renderOptions: ${JSON.stringify({ renderMode: page.renderMode, ...(options.dev === true ? { dev: true } : {}) })} }`;
    lines.push(
      `app.get(${JSON.stringify(page.pattern)}, __createPageGetHandler(${routeOptions}));`,
    );
    if (page.methods.includes('action') || page.methods.includes('actions')) {
      lines.push(
        `app.on(["POST", "PUT", "PATCH", "DELETE"], ${JSON.stringify(page.pattern)}, __createPageMutationHandler({ ...${routeOptions}, namedActions: ${JSON.stringify(page.methods.includes('actions'))} }));`,
      );
    }
  }
  lines.push('');
}

/** Asset fallthrough shared by native Void workers and Class A framework wrappers. */
export function compileAssetFallbackHelper(
  assetsDir = 'assets',
  serveSpaFallback = false,
  notFound: NotFoundHandling = 'none',
): string {
  return `import { createAssetFallback as __createAssetFallback } from ${JSON.stringify(ROUTING_RUNTIME_PATH)};
const serveWithAssets = __createAssetFallback(${JSON.stringify({ assetsDir, serveSpaFallback, notFound })});
`;
}

export interface WorkerEntryOptions {
  /** Native readiness proves the actual served Worker version through this binding. */
  versionMetadataBinding?: string;
  hasQueues?: boolean;
  remote?: {
    remotePath: string;
    bindingNames?: { d1?: string; kv?: string; r2?: string };
  };
  assetsDir?: string;
  webSocketClasses?: Array<string>;
  runtimeEnvPath?: string;
  /** Path to the `void/email` runtime used by the generated email handlers. */
  runtimeEmailPath?: string;
  envSchemaModule?: { importPath: string; helperPath: string };
  sandbox?:
    | boolean
    | { bindingName?: string; className?: string; instanceType?: string; runtimePath?: string };
  /**
   * Emit an SPA-style fallback in the asset-fallthrough path: when
   * `assetConfig.not_found_handling = "none"`, the worker returns
   * `/index.html` for HTML navigations after user routes have run. Pages
   * and SSR apps leave this disabled so intentional 404s stay 404.
   */
  serveSpaFallback?: boolean;
  /** Emit native email and authenticated receipt handlers. Requires `__emailHandler`. */
  hasEmail?: boolean;
  live?: boolean | { bindingName?: string; className?: string };
  /**
   * Whether the entry is compiled for the Vite dev server. Dev lets void/live
   * send the real internal error message to the client; builds never set it.
   */
  dev?: boolean;
  /**
   * When present, wraps the render path with the self-host ISR cache ladder.
   * `runtimePath` is the import specifier for `handleIsr`. The deployment id is
   * NOT passed here - the single source of truth is the compile-time
   * `__VOID_ISR_DEPLOYMENT_ID` const imported from the route table. Absent
   * for managed, dev, and non-ISR builds.
   */
  isr?: { runtimePath: string; queryAllowlist?: Record<string, Array<string>> };
  /**
   * Resolved `assetConfig.not_found_handling` for this build. Threaded to
   * `compileAssetFallbackHelper` so `routing.notFound: '404-page'` is honored
   * on the worker-first path. Defaults to `'none'`.
   */
  notFound?: NotFoundHandling;
  /**
   * User-defined Durable Object classes (`durable/` directory). Each entry is
   * imported from `filePath`, bound to `bindingName`, and re-exported as
   * `className` so wrangler's `durable_objects.bindings` can find it.
   */
  durableObjects?: Array<{
    bindingName: string;
    className: string;
    filePath: string;
    name?: string;
  }>;
}

/**
 * Generate the Worker entry module code.
 * Re-exports the Hono app from the virtual module with an asset-serving
 * fallthrough: when the app returns 404, the entry tries env.ASSETS.fetch()
 * and adds proper Cache-Control headers (immutable for Vite-hashed /assets/*).
 *
 * When `hasQueues` is true, also exports a `queue()` method that passes the
 * native MessageBatch to `__processQueue` and applies its ack/retry
 * decisions. Managed delivery uses the `/__void/queue` route instead.
 *
 * When `remote` is provided, wraps the fetch handler to detect
 * remote mode (`__VOID_REMOTE`) and replace local bindings with
 * proxy-backed versions.
 */
export function compileWorkerEntry(options: WorkerEntryOptions = {}): string {
  const {
    hasQueues = false,
    versionMetadataBinding,
    remote,
    assetsDir = 'assets',
    webSocketClasses = [],
    runtimeEnvPath = 'void/_env',
    runtimeEmailPath = 'void/email',
    envSchemaModule,
    sandbox,
    serveSpaFallback = false,
    hasEmail = false,
    live,
    dev = false,
    isr,
    notFound = 'none',
    durableObjects = [],
  } = options;
  const remotePath = remote?.remotePath;
  const remoteBindingNames = JSON.stringify(remote?.bindingNames);
  const createRemoteEnvCall = `createRemoteEnv(env${
    remote?.bindingNames ? `, ${remoteBindingNames}` : ''
  })`;
  const hasSandbox = sandbox === true || typeof sandbox === 'object';
  const sandboxClassName =
    typeof sandbox === 'object'
      ? (sandbox.className ?? DEFAULT_SANDBOX_CLASS_NAME)
      : DEFAULT_SANDBOX_CLASS_NAME;
  const sandboxBindingName =
    typeof sandbox === 'object' ? (sandbox.bindingName ?? 'SANDBOX') : 'SANDBOX';
  const sandboxRuntimePath =
    typeof sandbox === 'object' ? (sandbox.runtimePath ?? 'void/sandbox') : 'void/sandbox';
  const sandboxImport = hasSandbox
    ? `import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from ${JSON.stringify(sandboxRuntimePath)};\n`
    : '';
  const sandboxInstanceType = typeof sandbox === 'object' ? sandbox.instanceType : undefined;
  const sandboxExport = hasSandbox
    ? sandboxClassName === DEFAULT_SANDBOX_CLASS_NAME && !sandboxInstanceType
      ? `export { __VoidSandbox as SandboxV1 };\n__setSandboxBindingName(${JSON.stringify(sandboxBindingName)});\n`
      : `export class ${sandboxClassName} extends __VoidSandbox {${sandboxInstanceType ? ` protected override instanceType = ${JSON.stringify(sandboxInstanceType)} as const; ` : ''}}\n__setSandboxBindingName(${JSON.stringify(sandboxBindingName)});\n`
    : '';
  const hasLive = live === true || typeof live === 'object';
  const liveBindingName =
    typeof live === 'object' ? (live.bindingName ?? 'VOID_LIVE') : 'VOID_LIVE';
  const liveClassName =
    typeof live === 'object'
      ? (live.className ?? 'VoidLiveStreamDurableObject')
      : 'VoidLiveStreamDurableObject';
  const liveRouteImport = hasLive ? ', VoidLiveStreamDurableObject' : '';
  const liveDev = hasLive && dev === true;
  const liveRuntimeImport = hasLive
    ? `import { __setLiveBindingName${liveDev ? ', __setLiveDev' : ''} } from "void/live";\n`
    : '';
  const liveDevCall = liveDev ? '__setLiveDev(true);\n' : '';
  const liveExport = hasLive
    ? liveClassName === 'VoidLiveStreamDurableObject'
      ? `export { VoidLiveStreamDurableObject };\n__setLiveBindingName(${JSON.stringify(liveBindingName)});\n${liveDevCall}`
      : `export { VoidLiveStreamDurableObject as ${liveClassName} };\n__setLiveBindingName(${JSON.stringify(liveBindingName)});\n${liveDevCall}`
    : '';
  const durableObjectImports = durableObjects
    .map(
      ({ filePath }, index) =>
        `import __voidDurableObject${index} from ${JSON.stringify(filePath)};`,
    )
    .join('\n');
  const durableObjectExports = durableObjects
    .map(
      ({ bindingName, className, name }, index) =>
        `__voidDurableObject${index}.__bind(${JSON.stringify(bindingName)}${name !== undefined ? `, ${JSON.stringify(name)}` : ''});\nexport const ${className} = __voidDurableObject${index}.class;`,
    )
    .join('\n');
  const runtimeEnvImport = `import { withRuntimeEnv } from ${JSON.stringify(runtimeEnvPath)};\n`;
  const remoteImport = remote
    ? `import { createRemoteEnv } from ${JSON.stringify(remote.remotePath)};\n`
    : '';
  // Importing env.ts registers the schema that `_validateEnvOnce` checks.
  const envSchemaImport = envSchemaModule
    ? `import ${JSON.stringify(envSchemaModule.importPath)};\nimport { _validateEnvOnce } from ${JSON.stringify(envSchemaModule.helperPath)};\n`
    : '';
  const envValidateCall = envSchemaModule ? '  await _validateEnvOnce(env);\n' : '';
  // Discovery reads route metadata in a build-time worker without remote
  // secrets. Readiness and application requests must still validate at boot.
  const exactNames = isr ? INTERNAL_BINDING_EXACT_NAMES : [];
  const filterBindingsHelper = `import { filterInternalBindings as __filterBindings, createWorkerFetch as __createWorkerFetch } from ${JSON.stringify(ROUTING_RUNTIME_PATH)};
const __filterInternalBindings = (env) => __filterBindings(env, ${JSON.stringify(INTERNAL_BINDING_PREFIXES)}, ${JSON.stringify(exactNames)});
`;

  const assetHelper = compileAssetFallbackHelper(assetsDir, serveSpaFallback, notFound);

  // ISR wiring (self-host only, non-managed builds). When `isr` is absent
  // every fragment below is an empty string.
  const isrImport = isr
    ? `import { handleIsr } from ${JSON.stringify(isr.runtimePath)};\nimport { __VOID_ISR_REVALIDATE, __VOID_ISR_PAGES, __VOID_ISR_PATH_REVALIDATE, __VOID_ISR_DEPLOYMENT_ID } from 'virtual:void-routes';\n`
    : '';
  const isrDeploymentStamp = isr
    ? `  env.__VOID_ISR_DEPLOYMENT_ID ??= __VOID_ISR_DEPLOYMENT_ID;\n`
    : '';
  const fetchHandler = `__createWorkerFetch({
    app, assets: serveWithAssets, withRawEnv: __withRawEnv, withRuntimeEnv,
    filterBindings: __filterInternalBindings,
    internalRoute: __voidHandleInternalRoute,
    collectPrerenderPaths: __voidCollectPrerenderPaths${versionMetadataBinding ? ', versionMetadataBinding: ' + JSON.stringify(versionMetadataBinding) : ''}${envSchemaModule ? ', validateEnv: _validateEnvOnce' : ''}${remotePath ? ', remoteEnv: (env) => ' + createRemoteEnvCall : ''}${hasEmail ? ', emailReceipt: __handleEmailReceipt' : ''}${isr ? ', isr: { deploymentId: __VOID_ISR_DEPLOYMENT_ID, handle: (request, env, ctx, render) => handleIsr(request, env, ctx, { revalidate: __VOID_ISR_REVALIDATE, pages: __VOID_ISR_PAGES, pathRevalidate: __VOID_ISR_PATH_REVALIDATE, deploymentId: __VOID_ISR_DEPLOYMENT_ID, queryAllowlist: ' + JSON.stringify(isr.queryAllowlist) + ' }, render) }' : ''}
  })`;
  const remoteEnvSwap = remotePath
    ? `  if (env.__VOID_REMOTE === "1") env = ${createRemoteEnvCall};\n`
    : '';
  const scheduledHandler = `async function handleScheduled(controller, env, ctx) {
${envValidateCall}${remoteEnvSwap}${isrDeploymentStamp}  const userEnv = __filterInternalBindings(env);
  return withRuntimeEnv(env, () => scheduled(controller, userEnv, ctx));
}`;

  // Both the authenticated receipt endpoint and native Cloudflare email event
  // run the same handler. Native events replay recorded actions on the real
  // message; receipts return bounded action frames to the platform.
  const emailImport = hasEmail ? ', __emailHandler' : '';
  const emailProxyImport = hasEmail
    ? `import { createMessageProxy as __createMessageProxy, enactEmailActions as __enactEmailActions, isForwardableEmailMessage as __isForwardableEmailMessage } from ${JSON.stringify(runtimeEmailPath)};\nimport { EMAIL_PROTOCOL_VERSION as __EMAIL_PROTOCOL_VERSION, encodeEmailActions as __encodeEmailActions, readEmailEnvelope as __readEmailEnvelope, verifyEmailReceiptThroughProxy as __verifyEmailReceiptThroughProxy } from "void/_email-protocol";\n`
    : '';
  // Custom-domain receipts (`viaDomain`) carry no `<slug>+` prefix, so they get no slug.
  const emailHandler = hasEmail
    ? `async function handleEmail(envelope, env, ctx) {
${envValidateCall}${remoteEnvSwap}  const userEnv = __filterInternalBindings(env);
  const __relayed = typeof envelope.viaDomain === "string" && envelope.viaDomain.length > 0;
  const __slug = __relayed ? undefined : (typeof env.__VOID_PROJECT_SLUG === "string" && env.__VOID_PROJECT_SLUG.length > 0 ? env.__VOID_PROJECT_SLUG : undefined);
  const { message, getActions } = __createMessageProxy(envelope, { slug: __slug });
  await __withRawEnv(env, () => withRuntimeEnv(env, () => __emailHandler(message, userEnv, ctx, { slug: __slug })));
  const __actions = getActions();
  if (__isForwardableEmailMessage(envelope)) await __enactEmailActions(envelope, __actions);
  return __actions;
}`
    : '';

  const emailReceiptHandler = hasEmail
    ? `async function __handleEmailReceipt(request, env, ctx) {
  if (request.method !== "POST" || request.headers.get("content-encoding")) return new Response(null, { status: 404 });
  const __token = request.headers.get("x-void-email-receipt");
  const __recipient = request.headers.get("x-void-email-recipient");
  if (!__token || __token.length > 1536 || !__recipient || __recipient.length > 320 ||
      !env.__VOID_PROXY_TOKEN || !env.__PROJECT_ID || !env.__VOID_EMAIL_DEPLOYMENT_ID || !env.__VOID_PROXY) {
    return new Response(null, { status: 404 });
  }
  const __verified = await __verifyEmailReceiptThroughProxy(env.__VOID_PROXY, env.__VOID_PROXY_TOKEN, {
    receipt: __token, projectId: env.__PROJECT_ID,
    deploymentId: env.__VOID_EMAIL_DEPLOYMENT_ID, recipient: __recipient,
  });
  if (!__verified) return new Response(null, { status: 404 });
  let __envelope;
  try { __envelope = await __readEmailEnvelope(request.body); }
  catch { return new Response(null, { status: 400 }); }
  if (__envelope.to !== __recipient) return new Response(null, { status: 400 });
  const __actions = await handleEmail(__envelope, env, ctx);
  return new Response(__encodeEmailActions(__actions), {
    headers: { "content-type": "application/vnd.void.email-actions; version=" + __EMAIL_PROTOCOL_VERSION,
      "cache-control": "no-store" },
  });
}`
    : '';

  // The default export remains a WorkerEntrypoint for platform fetch dispatch.
  // Its email method accepts only native events on direct Cloudflare deploys;
  // platform mail enters through the authenticated receipt fetch endpoint.
  const entryImport = `import { WorkerEntrypoint } from "cloudflare:workers";\n`;
  const fetchDeclaration = `const __voidFetch = ${fetchHandler};`;
  const queueMethodBody = hasQueues
    ? `  async queue(batch) { return __voidQueue(batch, this.env, this.ctx); }\n`
    : '';
  const emailMethodBody = hasEmail
    ? `  async email(message) {
    if (this.env.__VOID_EMAIL_DEPLOYMENT_ID || !__isForwardableEmailMessage(message)) {
      throw new TypeError("Native email event required");
    }
    await handleEmail(message, this.env, this.ctx);
  }\n`
    : '';
  const entryClass = `export default class extends WorkerEntrypoint {
  async fetch(request) { return __voidFetch(request, this.env, this.ctx); }
  async scheduled(controller) { return handleScheduled(controller, this.env, this.ctx); }
${queueMethodBody}${emailMethodBody}}`;

  const queueImport = hasQueues ? ', __processQueue' : '';
  const queueFunction = hasQueues
    ? `async function __voidQueue(batch, env, ctx) {
${envValidateCall}${remoteEnvSwap}${isrDeploymentStamp}  const userEnv = __filterInternalBindings(env);
  const messages = [...batch.messages].map(m => ({
    id: m.id, timestamp: m.timestamp.toISOString(),
    body: m.body, attempts: m.attempts,
  }));
  const payload = { queue: batch.queue, messages };
  const __qr = await __withRawEnv(env, () => withRuntimeEnv(env, () => __processQueue(payload, userEnv)));
  if (__qr.decisions) {
    const __msgMap = new Map();
    for (const m of batch.messages) __msgMap.set(m.id, m);
    for (const [id, d] of Object.entries(__qr.decisions)) {
      const m = __msgMap.get(id);
      if (!m) continue;
      if (d.action === "ack") m.ack();
      else if (d.action === "retry") m.retry(d.delaySeconds != null ? { delaySeconds: d.delaySeconds } : undefined);
    }
  }
  if (!__qr.ok) throw new Error("queue: Handler failed.");
}

`
    : '';
  return `${sandboxImport}${entryImport}${liveRuntimeImport}import app, { scheduled, __voidCollectPrerenderPaths, __voidHandleInternalRoute, __withRawEnv${queueImport}${emailImport}${webSocketClasses.length > 0 ? `, ${webSocketClasses.join(', ')}` : ''}${liveRouteImport} } from 'virtual:void-routes';
${durableObjectImports}\n${runtimeEnvImport}${emailProxyImport}${envSchemaImport}${remoteImport}${isrImport}${filterBindingsHelper}${assetHelper}
${fetchDeclaration}
${scheduledHandler}
${emailHandler}
${emailReceiptHandler}
${queueFunction}${webSocketClasses.map((name) => `export { ${name} };`).join('\n')}
${liveExport}
${sandboxExport}
${durableObjectExports}
${entryClass}`;
}

/**
 * Generate the app module — exports the Hono app with static asset serving.
 * This is the entry imported by `vite preview` and can be used programmatically.
 */
export function compileNodeApp(
  target: 'node' | 'bun' | 'deno',
  honoPath: string,
  envSchemaModule?: { importPath: string; helperPath: string },
): string {
  const staticImport =
    target === 'bun'
      ? `import { serveStatic } from "hono/bun";`
      : target === 'deno'
        ? `import { serveStatic } from "hono/deno";`
        : `import { serveStatic } from "@hono/node-server/serve-static";`;

  const envSchemaImport = envSchemaModule
    ? `import ${JSON.stringify(envSchemaModule.importPath)};\nimport { _validateEnvOnce } from ${JSON.stringify(envSchemaModule.helperPath)};\n`
    : '';
  const envSource = target === 'deno' ? 'Deno.env.toObject()' : 'process.env';
  // Path discovery answers only the build-time prerender runner, which passes
  // `{ __VOID_PRERENDER: "1" }` as the Hono env. HTTP servers never do: Node
  // passes `{ incoming, outgoing }`, Bun its Server and Deno its handler info.
  const discoveryRequest = `c.req.method === "POST" && c.req.path === "/__void/prerender-paths" && c.env?.__VOID_PRERENDER === "1"`;
  const envMiddleware = envSchemaModule
    ? `app.use("*", async (c, next) => { if (!(${discoveryRequest})) await _validateEnvOnce(${envSource}); return next(); });\n`
    : '';

  return `${staticImport}
import { fileURLToPath } from "node:url";
import { Hono } from ${JSON.stringify(honoPath)};
import innerApp, { __voidCollectPrerenderPaths } from "virtual:void-routes";
${envSchemaImport}
// Resolved by nodeTargetPlugin for this emitted chunk, including shared chunks.
const clientRoot = fileURLToPath(import.meta.voidClientDirectory);
const assetApp = new Hono();
assetApp.get("*", serveStatic({ root: clientRoot }));
const assets = { fetch: (request) => assetApp.fetch(request) };
const app = new Hono();
${envMiddleware}app.post("/__void/prerender-paths", async (c) => {
  if (c.env?.__VOID_PRERENDER !== "1") return c.notFound();
  const paths = await __voidCollectPrerenderPaths(c.req.raw);
  return c.json({ paths });
});
app.get("/assets/*", (c) => assets.fetch(c.req.raw));
app.all("*", (c) => innerApp.fetch(c.req.raw, { ...c.env, ASSETS: assets }));
export default app;`;
}

/**
 * Generate the server entry — imports the app and starts an HTTP server.
 * This is what users run with `node dist/ssr/index.js`.
 */
export function compileNodeServer(target: 'node' | 'bun' | 'deno'): string {
  if (target === 'bun') {
    return `import app from "./app.js";

const port = Number(process.env.PORT || 3000);
Bun.serve({ fetch: app.fetch, port });
console.log("Listening on http://localhost:" + port);`;
  }

  if (target === 'deno') {
    return `import app from "./app.js";

const port = Number(Deno.env.get("PORT") || 3000);
Deno.serve({ port }, app.fetch);`;
  }

  // Node.js (default)
  return `import { serve } from "@hono/node-server";
import app from "./app.js";

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log("Listening on http://localhost:" + info.port);
});`;
}

/** Generate the browser client module: re-exports the HTTP fetch, stream, and auth clients. */
export function compileBrowserClient(
  authClientPath: string,
  fetchPath: string,
  fetchStreamPath: string,
): string {
  return `export { fetch, FetchError } from ${JSON.stringify(fetchPath)};
export { fetchStream, StreamError } from ${JSON.stringify(fetchStreamPath)};
export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};`;
}

function stripOriginForProd(rules: Array<DevRedirectRule>): Array<DevRedirectRule> {
  return rules.map(({ origin: _origin, ...rest }) => rest);
}

function compileRoutingRulesMiddleware(
  lines: Array<string>,
  rules: Array<DevRedirectRule>,
  dev: boolean,
): void {
  lines.push('// Routing rules: redirects + rewrites (applied before route handlers)');
  lines.push(`const __routingRules = ${JSON.stringify(dev ? rules : stripOriginForProd(rules))};`);
  lines.push('app.use("*", __routingRuntime.routingMiddleware(__routingRules));');
}

function compileHeaderMiddleware(lines: Array<string>, rules: Array<HeaderRule>): void {
  lines.push('// Header rules (applied to responses)');
  lines.push(`const __headerRules = ${JSON.stringify(rules)};`);
  lines.push('app.use("*", __routingRuntime.headerMiddleware(__headerRules));');
}

/** Generate the server-side fetch client, which calls `app.fetch()` with the current request's credentials. */
export function compileWorkerClient(authClientPath: string, nodeTarget = false): string {
  const envImport = nodeTarget ? '' : 'import { env } from "cloudflare:workers";\n';
  const dispatch = nodeTarget
    ? 'app.fetch(request)'
    : 'app.fetch(request, env, store?.executionCtx ?? { waitUntil() {}, passThroughOnException() {} })';
  return `import app, { requestContext } from "virtual:void-routes";
import { createServerFetch } from ${JSON.stringify(FETCH_SERVER_PATH)};
export { FetchError } from ${JSON.stringify(FETCH_SERVER_PATH)};
${envImport}export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};

export const fetch = createServerFetch(
  (request, store) => ${dispatch},
  () => requestContext.getStore(),
  "${nodeTarget ? 'http://localhost' : 'http://worker.local'}",
);
`;
}

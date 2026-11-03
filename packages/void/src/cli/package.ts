import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hash as blake3hash } from 'blake3-jit';
import ignore from 'ignore';
import { extname, join, relative } from 'pathslash';
import { needsApplicationDatabase } from '../application-features.ts';
import type { NotFoundHandling } from '../config.ts';
import type { InferredBindings } from '../inference/walk.ts';
import { buildMigrationPlanBundle } from '../migrations/plan.ts';
import type { MigrationFile } from '../migrations/validate.ts';
import type { WebSocketRouteDefinition } from '../router/websocket.ts';
import type { ResolvedSandboxConfig } from '../sandbox/config.ts';
import { collectFiles } from '../shared/collect-files.ts';
import type {
  AssetConfig,
  DeployAssetManifestEntry,
  DeployManifest,
  DevRedirectRule,
  HeaderRule,
  QueueMeta,
  RedirectRule,
  SandboxManifestMeta,
  ScheduleMeta,
  WebSocketManifestMeta,
} from './types.ts';
export type { DeployAssetManifestEntry as AssetManifestEntry } from './types.ts';
import {
  DEFAULT_LIVE_BINDING,
  DEFAULT_LIVE_CLASS,
  LIVE_MIGRATION_TAG,
  type LiveBindingConfig,
} from './wrangler.ts';

const textEncoder = new TextEncoder();

type ProgressCallback = (message: string) => void;

/**
 * Strip dev-only / internal-only fields from each rule before shipping the
 * manifest. The resulting entries contain only `{ source, destination, status }`.
 *
 * - `origin` is used to build the `X-Void-Routing` trace header during local
 *   dev; the deployed platform doesn't consume it.
 * - `force` is used internally by the CLI/router to split rules into the
 *   `redirectRules` (pre-asset, always-fires) and `fallbackRules` (post-asset,
 *   only when the asset resolver 404s) buckets and to label the trace header
 *   on `node`/`bun`/`deno` targets. The platform dispatch worker decides phase
 *   purely from which array the rule lives in, so shipping `force` is dead weight.
 *
 * Keep in sync with `stripOriginForProd` in `router/compile.ts`, which strips
 * only `origin` because the Node/Bun/Deno-target generated code still reads
 * `force` at runtime to label the dev trace header.
 */
function stripDevOnlyRuleFields(
  rules: Array<DevRedirectRule> | undefined,
): Array<RedirectRule> | undefined {
  if (!rules) {
    return rules;
  }
  return rules.map(({ origin: _origin, force: _force, ...rest }) => rest);
}

/**
 * Layer user `routing.fallbacks` over the SPA default. The platform SPA switch
 * is global, so a SPA with user fallbacks turns it off and appends a synthetic
 * `/* -> /index.html` rule after them (first match wins). An explicit
 * `routing.notFound` is resolved first, so overriding away from SPA also skips
 * the synthetic rule. `detectPreset` classes a plain Vite MPA as `spa`, so this
 * override is its only escape hatch.
 */
export function resolveSpaFallbackChain(
  appType: 'spa' | 'static' | undefined,
  fallbackRules: Array<DevRedirectRule> | undefined,
  notFound?: NotFoundHandling,
): {
  assetConfig: AssetConfig;
  fallbackRules: Array<DevRedirectRule> | undefined;
} {
  const userRules = fallbackRules && fallbackRules.length > 0 ? fallbackRules : undefined;

  const handling: NotFoundHandling =
    notFound ??
    (appType === 'spa' ? 'single-page-application' : appType === 'static' ? '404-page' : 'none');

  if (handling !== 'single-page-application') {
    return {
      assetConfig: { not_found_handling: handling },
      fallbackRules: userRules,
    };
  }

  if (!userRules) {
    // No user fallbacks — keep the zero-overhead platform SPA switch.
    return {
      assetConfig: { not_found_handling: 'single-page-application' },
      fallbackRules: undefined,
    };
  }

  // An unscoped user `/* -> /index.html` already is the catch-all; a duplicate
  // would trip the duplicate-source lint. A host-scoped one covers one host only.
  const alreadyHasCatchAll = userRules.some(
    (r) => r.host === undefined && r.source === '/*' && r.destination === '/index.html',
  );
  if (alreadyHasCatchAll) {
    return { assetConfig: { not_found_handling: 'none' }, fallbackRules: userRules };
  }
  const syntheticSpaFallback: DevRedirectRule = {
    source: '/*',
    destination: '/index.html',
    status: 200,
    force: false,
    origin: 'spa-default',
  };
  return {
    assetConfig: { not_found_handling: 'none' },
    fallbackRules: [...userRules, syntheticSpaFallback],
  };
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

const PROGRESS_CHUNK = 50;

/**
 * Yield to the event loop every PROGRESS_CHUNK iterations so spinner ticks
 * can repaint, and emit a progress message via onProgress. Otherwise the
 * tight sync loop blocks the spinner interval and the user sees no updates.
 */
async function tickProgress(
  i: number,
  total: number,
  onProgress: ProgressCallback | undefined,
  label: string,
): Promise<void> {
  if (!onProgress) {
    return;
  }
  if (i % PROGRESS_CHUNK !== 0 && i !== total) {
    return;
  }
  onProgress(`${label} (${i}/${total})`);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Compute a CF-compatible asset hash: BLAKE3 of base64(content) + extension,
 * first 32 hex chars. Matches Wrangler's hashFile algorithm exactly.
 * Must match the API's computeAssetHash algorithm exactly.
 */
export function computeAssetHash(content: Buffer, filePath: string): string {
  const base64 = content.toString('base64');
  const ext = extname(filePath).substring(1);
  const input = textEncoder.encode(base64 + ext);
  return Buffer.from(blake3hash(input)).toString('hex').slice(0, 32);
}

/**
 * Compute MD5 of raw content as a 32-char lowercase hex string.
 *
 * Used as the wire-level upload-integrity primitive on direct-to-R2 PUTs:
 * R2's S3 compatibility layer enforces `Content-MD5` (RFC 1864) on PutObject,
 * so the upload itself fails if uploaded bytes don't match the declared MD5.
 * MD5 collision resistance is acceptable here because (a) this hash is purely
 * an upload-integrity primitive (BLAKE3 remains the canonical content key),
 * and (b) project-scoped storage (`assets/${projectId}/${blake3}`) means any
 * collision attack is exploitable only against the attacker's own project.
 */
function computeMd5(content: Buffer): string {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Create a filter function that excludes .assetsignore, _headers, _redirects,
 * OS metadata files, dotenv files, deploy-internal patterns, and any patterns
 * listed in a .assetsignore file.
 * Matches Wrangler's createAssetsIgnoreFunction from workers-shared/utils/helpers.ts.
 */
function createAssetsIgnoreFunction(
  dir: string,
  extraPatterns: Array<string> = [],
): {
  isIgnored: (relativePath: string) => boolean;
  assetsIgnoreFilePresent: boolean;
} {
  const patterns = [
    '/.assetsignore',
    '/_redirects',
    '/_headers',
    '.DS_Store',
    '.env',
    '.env.*',
    ...extraPatterns,
  ];
  const assetsIgnorePath = join(dir, '.assetsignore');
  let assetsIgnoreFilePresent = false;
  if (existsSync(assetsIgnorePath)) {
    assetsIgnoreFilePresent = true;
    const content = readFileSync(assetsIgnorePath, 'utf-8');
    patterns.push(...content.split('\n'));
  }
  const ig = ignore().add(patterns);
  // ignore library expects relative paths without leading /
  const isIgnored = (relativePath: string) => {
    const normalized = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return ig.test(normalized).ignored;
  };
  return { isIgnored, assetsIgnoreFilePresent };
}

/**
 * Guard against accidentally uploading _worker.js as a static asset.
 * Matches Wrangler's errorOnLegacyPagesWorkerJSAsset behavior:
 * throws only when no .assetsignore file exists (if .assetsignore is present
 * but doesn't exclude _worker.js, the user intentionally wants to upload it).
 */
function checkWorkerJsAsset(relativePath: string, assetsIgnoreFilePresent: boolean): void {
  if (assetsIgnoreFilePresent) {
    return;
  }
  const name = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  if (name === '_worker.js' || name.startsWith('_worker.js/')) {
    const type = name === '_worker.js' ? 'file' : 'directory';
    throw new Error(
      `deploy: Refusing to upload _worker.js ${type} as an asset. ` +
        `This could expose private server-side code to the public Internet. ` +
        `If this is unintended, remove it or add a .assetsignore file containing "_worker.js". ` +
        `If intentional, add an empty .assetsignore file to suppress this error.`,
    );
  }
}

/**
 * Collect all files in a directory, compute hashes, and return both the
 * manifest (for preflight) and the raw file map (for selective packaging).
 *
 * Each file is read from disk exactly once. Both BLAKE3 (storage key) and
 * MD5 (R2 upload-integrity) digests are derived from that single buffer.
 */
export async function collectAndHashAssets(
  dir: string,
  onProgress?: ProgressCallback,
  opts: { ignorePatterns?: Array<string> } = {},
): Promise<{
  assetManifest: Record<string, DeployAssetManifestEntry>;
  assetFiles: Map<string, Buffer>;
}> {
  const assetManifest: Record<string, DeployAssetManifestEntry> = {};
  const assetFiles = new Map<string, Buffer>();

  try {
    const { isIgnored, assetsIgnoreFilePresent } = createAssetsIgnoreFunction(
      dir,
      opts.ignorePatterns,
    );
    const files = collectAssetFiles(dir, isIgnored);
    let processed = 0;
    for (const filePath of files) {
      processed++;
      await tickProgress(processed, files.length, onProgress, 'Hashing assets');
      // `collectAssetFiles` already skipped ignored paths.
      const relativePath = '/' + relative(dir, filePath);
      checkWorkerJsAsset(relativePath, assetsIgnoreFilePresent);
      const content = readFileSync(filePath);
      const blake3 = computeAssetHash(content, filePath);
      assetManifest[relativePath] = {
        blake3,
        md5: computeMd5(content),
        size: content.length,
        // Deprecated v1 alias of `blake3` for consumers still reading `entry.hash`.
        hash: blake3,
      };
      assetFiles.set(relativePath, content);
    }
  } catch (err) {
    // Only swallow directory-not-found errors; re-throw everything else
    // (e.g. _worker.js safety guard)
    if (!isNotFoundError(err)) {
      throw err;
    }
    // Directory doesn't exist — no assets
  }

  return { assetManifest, assetFiles };
}

/** Optional overrides for binding names and worker metadata. */
export type PackageOptions = {
  /** Custom binding names (e.g. { d1: "MY_DB" }). Defaults: DB, KV, STORAGE. */
  bindingNames?: { d1?: string; kv?: string; r2?: string; sandbox?: string };
  /** Worker entry module filename (e.g. "index.mjs"). */
  workerMain?: string;
  /** Cloudflare compatibility_date from framework's wrangler config. */
  compatibilityDate?: string;
  /** Cloudflare compatibility_flags from framework's wrangler config. */
  compatibilityFlags?: Array<string>;
  /** Workers CPU-time limit (ms) from void.config.ts `worker.limits.cpu_ms`. */
  cpuMs?: number;
  /** Cloudflare Sandbox container metadata for platform deploys. */
  sandbox?: ResolvedSandboxConfig;
  /** Resolved void/live Durable Object binding and class names. */
  live?: LiveBindingConfig;
  /** Query params kept in the ISR cache key for every request to a matching path; all others are left out. */
  revalidateQueryAllowlist?: Record<string, Array<string>>;
};

function toWebSocketManifest(
  routes: Array<WebSocketRouteDefinition> | undefined,
): WebSocketManifestMeta | undefined {
  if (!routes || routes.length === 0) {
    return undefined;
  }
  return {
    routes: routes.map((route) => ({
      pattern: route.pattern,
      filePath: route.filePath,
      className: route.className,
      mode: route.mode,
      hasAuthGate: route.hasAuthGate,
    })),
    classes: routes.map((route) => route.className),
  };
}

function toSandboxManifest(sandbox: ResolvedSandboxConfig): SandboxManifestMeta {
  return {
    controllerProtocol: 2,
    bindingName: sandbox.binding,
    className: sandbox.className,
    containerName: sandbox.containerName,
    image: sandbox.platformImage,
    ...(sandbox.instanceType && { instanceType: sandbox.instanceType }),
  };
}

function toLiveManifest(live?: LiveBindingConfig): import('./types.ts').LiveManifestMeta {
  const bindingName = live?.bindingName ?? DEFAULT_LIVE_BINDING;
  const className = live?.className ?? DEFAULT_LIVE_CLASS;
  return {
    bindingName,
    className,
    storage: 'sqlite',
    classes: [className],
    migrations: [{ tag: LIVE_MIGRATION_TAG, newSqliteClasses: [className] }],
  };
}

/**
 * If the user configured `routing.fallbacks` on an app whose resolved
 * `not_found_handling` is not `single-page-application`, the platform still
 * applies the rules but no `/* -> /index.html` SPA shell is synthesised —
 * unmatched paths fall through to the platform 404. Returns the warning
 * message string when that mismatch is detected, or `null` otherwise. Pure
 * function; callers decide whether/how to surface the message (CLI progress,
 * `console.warn`, etc.).
 *
 * The message names `not_found_handling` rather than the app type because an
 * explicit `routing.notFound` can land here too — the app may well be a SPA.
 */
export function detectNonSpaFallbackWarning(
  assetConfig: AssetConfig | undefined,
  fallbackRules: Array<DevRedirectRule> | undefined,
): string | null {
  if (assetConfig?.not_found_handling === 'single-page-application') {
    return null;
  }
  if (!fallbackRules || fallbackRules.length === 0) {
    return null;
  }
  return (
    `routing.fallbacks is set but not_found_handling is not "single-page-application"; ` +
    `fallbacks will be applied, ` +
    `but no "/* -> /index.html" SPA shell fallback is synthesised — unmatched paths fall through to the platform 404.`
  );
}

/** Add the database, KV, R2, and AI bindings shared by Void and framework manifests. */
function applyResourceBindings(
  manifest: DeployManifest,
  bindings: InferredBindings,
  migrationCount: number,
  dialect: 'sqlite' | 'postgresql' | 'mysql',
  bindingNames: PackageOptions['bindingNames'],
): void {
  if (needsApplicationDatabase(bindings, migrationCount)) {
    if (dialect !== 'sqlite') {
      manifest.bindings.hyperdrive = ['HYPERDRIVE'];
    } else {
      manifest.bindings.d1 = [bindingNames?.d1 ?? 'DB'];
    }
  }
  if (bindings.needsKV) {
    manifest.bindings.kv = [bindingNames?.kv ?? 'KV'];
  }
  if (bindings.needsR2) {
    manifest.bindings.r2 = [bindingNames?.r2 ?? 'STORAGE'];
  }
  if (bindings.needsAI) {
    manifest.bindings.ai = true;
  }
}

/** Describe bundled migrations; SQLite migrations also carry their plan bundle. */
function toMigrationsManifest(
  migrations: Array<MigrationFile>,
  dialect: 'sqlite' | 'postgresql' | 'mysql',
): NonNullable<DeployManifest['migrations']> {
  const planBundle = dialect === 'sqlite' ? buildMigrationPlanBundle(migrations) : undefined;
  return {
    dialect,
    ...(planBundle
      ? {
          classifierVersion: planBundle.classifierVersion,
          migrationListHash: planBundle.migrationListHash,
          protocolVersion: planBundle.protocolVersion,
          stability: planBundle.plans.some((plan) => plan.stability === 'legacy')
            ? 'legacy'
            : 'stable',
        }
      : {}),
    pending: migrations.length,
  };
}

/**
 * Build a Void-app deploy manifest from the inferred bindings + per-feature
 * inputs. Pure shape transformation: reads no files, has no I/O.
 *
 * Note: callers are responsible for surfacing the non-SPA-fallbacks warning
 * (see `detectNonSpaFallbackWarning`) before invoking this builder. The
 * builder itself stays I/O-free.
 */
export function buildVoidManifest(opts: {
  bindings: InferredBindings;
  hasEmailHandlers?: boolean;
  migrations?: Array<MigrationFile>;
  schedules?: Array<ScheduleMeta>;
  ssr?: boolean;
  framework?: string;
  revalidate?: number | Record<string, number>;
  pages?: Array<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  vars?: Record<string, string>;
  queues?: Array<QueueMeta>;
  prerender?: Array<string>;
  assetConfig?: AssetConfig;
  options?: PackageOptions;
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  alwaysUseHttps?: boolean;
  redirectRules?: Array<DevRedirectRule>;
  fallbackRules?: Array<DevRedirectRule>;
  dialect?: 'sqlite' | 'postgresql' | 'mysql';
  webSockets?: Array<WebSocketRouteDefinition>;
  durableObjects?: ReadonlyArray<{ bindingName: string; className: string }>;
}): DeployManifest {
  const {
    bindings,
    migrations,
    schedules,
    ssr,
    framework,
    revalidate,
    pages,
    pathRevalidate,
    vars,
    queues,
    prerender,
    assetConfig,
    options,
    hashedAssetsPrefix,
    headerRules,
    redirectRules,
    fallbackRules,
    dialect,
    webSockets,
  } = opts;
  const resolvedDialect = dialect ?? 'sqlite';

  const manifest: DeployManifest = { version: 3, assetManifestVersion: 2, bindings: {} };
  if (opts.alwaysUseHttps !== undefined) {
    manifest.alwaysUseHttps = opts.alwaysUseHttps;
  }
  if (opts.durableObjects?.length) {
    manifest.version = 4;
    manifest.durableObjects = {
      bindings: opts.durableObjects.map(({ bindingName, className }) => ({
        bindingName,
        className,
        storage: 'sqlite',
      })),
    };
  }
  if (opts.hasEmailHandlers) {
    manifest.emailProtocolVersion = 1;
  }
  if (bindings.needsAuth) {
    manifest.auth = true;
  }
  applyResourceBindings(
    manifest,
    bindings,
    migrations?.length ?? 0,
    resolvedDialect,
    options?.bindingNames,
  );
  if (bindings.needsSandbox) {
    if (!options?.sandbox) {
      throw new Error('deploy: Sandbox bindings require sandbox package options.');
    }
    manifest.sandbox = toSandboxManifest({
      ...options.sandbox,
      binding: options.bindingNames?.sandbox ?? options.sandbox.binding,
    });
  }
  if (bindings.needsLive) {
    manifest.live = toLiveManifest(options?.live);
  }

  if (migrations && migrations.length > 0) {
    manifest.migrations = toMigrationsManifest(migrations, resolvedDialect);
  }

  if (schedules && schedules.length > 0) {
    manifest.schedules = schedules;
  }

  if (queues && queues.length > 0) {
    manifest.queues = queues;
  }

  if (ssr) {
    manifest.ssr = true;
  }

  if (framework) {
    manifest.framework = framework;
  }

  manifest.type = framework ? 'framework' : 'void';

  if (revalidate != null && revalidate !== 0) {
    manifest.revalidate = revalidate;
  }
  if (
    options?.revalidateQueryAllowlist &&
    Object.keys(options.revalidateQueryAllowlist).length > 0
  ) {
    manifest.revalidateQueryAllowlist = options.revalidateQueryAllowlist;
  }

  if (pages && pages.length > 0) {
    manifest.pages = pages;
  }

  if (pathRevalidate && Object.keys(pathRevalidate).length > 0) {
    manifest.pathRevalidate = pathRevalidate;
  }

  if (prerender && prerender.length > 0) {
    manifest.prerender = prerender;
  }

  let resolvedAssetConfig = assetConfig;
  let resolvedFallbackRules = fallbackRules;
  if (assetConfig?.not_found_handling === 'single-page-application') {
    const chain = resolveSpaFallbackChain('spa', fallbackRules);
    resolvedAssetConfig = { ...assetConfig, ...chain.assetConfig };
    resolvedFallbackRules = chain.fallbackRules;
  }

  if (resolvedAssetConfig) {
    manifest.assetConfig = resolvedAssetConfig;
  }

  if (vars && Object.keys(vars).length > 0) {
    manifest.vars = vars;
  }

  if (options?.workerMain) {
    manifest.workerMain = options.workerMain;
  }
  if (options?.compatibilityDate) {
    manifest.compatibilityDate = options.compatibilityDate;
  }
  if (options?.compatibilityFlags && options.compatibilityFlags.length > 0) {
    manifest.compatibilityFlags = options.compatibilityFlags;
  }
  if (options?.cpuMs) {
    manifest.limits = { cpuMs: options.cpuMs };
  }

  if (hashedAssetsPrefix) {
    manifest.hashedAssetsPrefix = hashedAssetsPrefix;
  }

  if (headerRules && headerRules.length > 0) {
    manifest.headerRules = headerRules;
  }

  if (redirectRules && redirectRules.length > 0) {
    manifest.redirectRules = stripDevOnlyRuleFields(redirectRules);
  }

  if (resolvedFallbackRules && resolvedFallbackRules.length > 0) {
    manifest.fallbackRules = stripDevOnlyRuleFields(resolvedFallbackRules);
  }

  const websocketManifest = toWebSocketManifest(webSockets);
  if (websocketManifest) {
    manifest.websocket = websocketManifest;
  }

  return manifest;
}

/**
 * Read every worker module under `workerDir` once and return them as a map
 * keyed by relative path. Skipped files (build metadata, wrangler config,
 * non-module extensions) are filtered out by `isWorkerModule`. Reads each
 * file from disk exactly once — buffer threading downstream is the caller's
 * responsibility.
 */
export function collectWorkerFiles(workerDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let workerPaths: Array<string>;
  try {
    workerPaths = collectFiles(workerDir);
  } catch (err) {
    if (isNotFoundError(err)) {
      return out;
    }
    throw err;
  }
  for (const filePath of workerPaths) {
    const relativePath = relative(workerDir, filePath);
    if (!isWorkerModule(relativePath)) {
      continue;
    }
    out.set(relativePath, readFileSync(filePath));
  }
  return out;
}

const WRANGLER_HTML_HANDLING = new Set<AssetConfig['html_handling']>([
  'auto-trailing-slash',
  'force-trailing-slash',
  'drop-trailing-slash',
  'none',
]);

/** Read `assets.html_handling` from a materialized root Wrangler config object. */
export function readWranglerHtmlHandling(
  rootConfig: Record<string, unknown>,
): AssetConfig['html_handling'] | undefined {
  const assets = rootConfig.assets;
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) {
    return undefined;
  }
  const value = (assets as Record<string, unknown>).html_handling;
  return typeof value === 'string' &&
    WRANGLER_HTML_HANDLING.has(value as AssetConfig['html_handling'])
    ? (value as AssetConfig['html_handling'])
    : undefined;
}

/**
 * Build a static-deploy manifest. Pure shape transformation — no I/O.
 */
export function buildStaticManifest(opts: {
  appType: 'spa' | 'static';
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  alwaysUseHttps?: boolean;
  redirectRules?: Array<DevRedirectRule>;
  fallbackRules?: Array<DevRedirectRule>;
  /** Explicit `routing.notFound` — overrides the appType-inferred handling. */
  notFound?: NotFoundHandling;
  /** Authored `cloudflare.assets.html_handling` from the root Wrangler config. */
  html_handling?: AssetConfig['html_handling'];
}): DeployManifest {
  const {
    appType,
    hashedAssetsPrefix,
    headerRules,
    redirectRules,
    fallbackRules,
    notFound,
    html_handling,
  } = opts;
  const { assetConfig, fallbackRules: resolvedFallbackRules } = resolveSpaFallbackChain(
    appType,
    fallbackRules,
    notFound,
  );
  const resolvedAssetConfig =
    html_handling === undefined ? assetConfig : { ...assetConfig, html_handling };

  const manifest: DeployManifest = {
    version: 3,
    assetManifestVersion: 2,
    bindings: {},
    type: appType,
    ...(opts.alwaysUseHttps !== undefined ? { alwaysUseHttps: opts.alwaysUseHttps } : {}),
    assetConfig: resolvedAssetConfig,
  };

  if (hashedAssetsPrefix) {
    manifest.hashedAssetsPrefix = hashedAssetsPrefix;
  }

  if (headerRules && headerRules.length > 0) {
    manifest.headerRules = headerRules;
  }

  if (redirectRules && redirectRules.length > 0) {
    manifest.redirectRules = stripDevOnlyRuleFields(redirectRules);
  }

  if (resolvedFallbackRules && resolvedFallbackRules.length > 0) {
    manifest.fallbackRules = stripDevOnlyRuleFields(resolvedFallbackRules);
  }

  return manifest;
}

/**
 * Build a framework-deploy manifest. Pure shape transformation — no I/O.
 */
export function buildFrameworkManifest(opts: {
  frameworkName: string;
  workerMain: string;
  bindings: InferredBindings;
  migrations?: Array<MigrationFile>;
  schedules?: Array<ScheduleMeta>;
  queues?: Array<QueueMeta>;
  revalidate?: number | Record<string, number>;
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  prerender?: Array<string>;
  vars?: Record<string, string>;
  assetConfig?: AssetConfig;
  packageOptions?: Omit<PackageOptions, 'workerMain'>;
  hashedAssetsPrefix?: string;
  headerRules?: Array<HeaderRule>;
  alwaysUseHttps?: boolean;
  redirectRules?: Array<DevRedirectRule>;
  fallbackRules?: Array<DevRedirectRule>;
  dialect?: 'sqlite' | 'postgresql' | 'mysql';
}): DeployManifest {
  const po = opts.packageOptions;
  const dialect = opts.dialect ?? 'sqlite';

  const manifest: DeployManifest = { version: 3, assetManifestVersion: 2, bindings: {} };
  if (opts.alwaysUseHttps !== undefined) {
    manifest.alwaysUseHttps = opts.alwaysUseHttps;
  }
  applyResourceBindings(
    manifest,
    opts.bindings,
    opts.migrations?.length ?? 0,
    dialect,
    po?.bindingNames,
  );

  if (opts.migrations && opts.migrations.length > 0) {
    manifest.migrations = toMigrationsManifest(opts.migrations, dialect);
  }

  if (opts.schedules && opts.schedules.length > 0) {
    manifest.schedules = opts.schedules;
  }
  if (opts.queues && opts.queues.length > 0) {
    manifest.queues = opts.queues;
  }
  if (opts.revalidate != null && opts.revalidate !== 0) {
    manifest.revalidate = opts.revalidate;
  }
  if (opts.revalidateQueryAllowlist && Object.keys(opts.revalidateQueryAllowlist).length > 0) {
    manifest.revalidateQueryAllowlist = opts.revalidateQueryAllowlist;
  }
  if (opts.prerender && opts.prerender.length > 0) {
    manifest.prerender = opts.prerender;
  }
  if (opts.assetConfig) {
    manifest.assetConfig = opts.assetConfig;
  }
  if (opts.vars && Object.keys(opts.vars).length > 0) {
    manifest.vars = opts.vars;
  }

  manifest.ssr = true;
  manifest.framework = opts.frameworkName;
  manifest.type = 'framework';
  manifest.workerMain = opts.workerMain;
  if (po?.compatibilityDate) {
    manifest.compatibilityDate = po.compatibilityDate;
  }
  if (po?.compatibilityFlags && po.compatibilityFlags.length > 0) {
    manifest.compatibilityFlags = po.compatibilityFlags;
  }
  if (po?.cpuMs) {
    manifest.limits = { cpuMs: po.cpuMs };
  }

  if (opts.hashedAssetsPrefix) {
    manifest.hashedAssetsPrefix = opts.hashedAssetsPrefix;
  }

  if (opts.headerRules && opts.headerRules.length > 0) {
    manifest.headerRules = opts.headerRules;
  }

  if (opts.redirectRules && opts.redirectRules.length > 0) {
    manifest.redirectRules = stripDevOnlyRuleFields(opts.redirectRules);
  }

  if (opts.fallbackRules && opts.fallbackRules.length > 0) {
    manifest.fallbackRules = stripDevOnlyRuleFields(opts.fallbackRules);
  }

  return manifest;
}

/**
 * Check if a file (by relative path) should be included as a worker module.
 * Skips build metadata and files with extensions CF Workers can't handle as modules.
 */
function isWorkerModule(relativePath: string): boolean {
  const norm = relativePath.replace(/\\/g, '/');
  // Skip build metadata at any depth
  if (norm.includes('/.vite/') || norm.startsWith('.vite/')) {
    return false;
  }
  // Skip wrangler config
  if (norm === 'wrangler.json' || norm === 'wrangler.jsonc') {
    return false;
  }
  // Only include CF-compatible module extensions
  return /\.(js|mjs|cjs|wasm|map|txt)$/.test(norm);
}

/**
 * Recursively collect static asset file paths, refusing symlinks so deploys
 * cannot publish bytes from outside the intended asset root.
 */
function collectAssetFiles(
  root: string,
  isIgnored: (relativePath: string) => boolean,
  dir: string = root,
): Array<string> {
  const files: Array<string> = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = '/' + relative(root, fullPath);
    if (isIgnored(relativePath)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`deploy: Refusing to upload symlink as an asset: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...collectAssetFiles(root, isIgnored, fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

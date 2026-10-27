import { redirectToHttps, type ProjectZeroTrustRouting } from '@void/edge';
import { clientRevalidateResponse, isEventStreamResponse } from '@void/isr/runtime';
import {
  PLATFORM_HEALTH_HOSTNAME_LABEL,
  platformHealthHostname,
  readPlatformApplication,
  resolvePlatformApplicationEnvironment,
} from '@void/platform';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { projectAccessVerifier } from './access.ts';
import type { Env } from './env.ts';
import { createErrorResponse, createMaintenanceResponse } from './error-page.ts';
import { applyHeaderRules, type HeaderRule } from './headers.ts';
import {
  readIsrCache,
  writeIsrCache,
  deleteIsrCache,
  isStale,
  isrCacheResponse,
  isrEdgeCacheKey,
  isrEdgeCacheKeyJson,
  hasCurrentSharedCachePolicy,
  hasSharedCacheOptOut,
  SHARED_CACHE_POLICY_HEADER,
  markSharedCachePolicy,
  resolveRevalidateTtl,
  resolvePathTtl,
  resolvePageTtl,
  matchesLiteralPage,
  isDottedPathIsrEligible,
  shouldBypassIsr,
  isFrameworkDocumentRequest,
  extractPageDataFromHtml,
  normalizePageDataForJsonCache,
} from './isr.ts';
import { createLimitResponse } from './limit-response.ts';
import {
  recordPlatformLog,
  recordRequest,
  sendUsageEvent,
  type FailureKind,
  type RequestType,
} from './metering.ts';
import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from './platform-lifecycle.ts';
import { applicationEdgeCache, resolveProjectHostname } from './project-hostname.ts';
import { classifyDynamicRequestType, hasExtension, isApiPath } from './request-type.ts';
import { applyRoutingRules, mergeQueryIntoLocation, type RedirectRule } from './routing-rules.ts';
import { resolveStaticPath, resolveAssetContentType, safeDecodePathname } from './static.ts';
import type { AssetConfig } from './static.ts';
import {
  buildVariantOriginalUrl,
  exactQueryAllowlist,
  hasUnlistedQueryParams,
  type QueryAllowlist,
} from './variant-key.ts';
import {
  DispatchTimeoutError,
  resolveTimeoutMs,
  withDelayedHedge,
  withTimeout,
} from './with-timeout.ts';

type RoutingEntry = Readonly<{
  workerName: string;
  projectId: string;
  userId?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
  // RAW per-path `routing.revalidate` OBJECT config (pages mode). Resolved at
  // the edge against the real request path for a matched inherit-eligible page
  // (a `pages` entry with no baked `revalidate`) — honors per-path `0` opt-outs
  // a dynamic pattern straddles. Distinct from the folded `revalidate` map.
  pathRevalidate?: Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
  headerRules?: ReadonlyArray<HeaderRule>;
  // `redirectRules` fires pre-asset, `fallbackRules` fires post-asset.
  // List identity encodes the pre-vs-post-asset semantic.
  redirectRules?: ReadonlyArray<RedirectRule>;
  alwaysUseHttps?: boolean;
  fallbackRules?: ReadonlyArray<RedirectRule>;
  // Per-pathname allowlist of query params that are part of the ISR variant
  // key on a rewrite. Default (no entry / no allowlist) drops every param,
  // so an attacker can't fan out the cache by varying `?utm`/`?cb`/etc.
  queryAllowlist?: QueryAllowlist;
  staticDeploymentId?: string;
  assetManifestId?: string;
  assetConfig?: AssetConfig;
  zeroTrust?: ProjectZeroTrustRouting;
  privatePreview?: boolean;
}>;

// Written by the API (suspension.ts projectSuspensionKey) while an administrator
// has suspended the project's owner.
async function isProjectSuspended(env: Env, projectId: string): Promise<boolean> {
  try {
    return (await env.ROUTING.get(`project-suspended:${projectId}`, { cacheTtl: 60 })) !== null;
  } catch (error) {
    console.error(`[queue-relay] suspension check failed project="${projectId}"; relaying`, error);
    return false;
  }
}

type QueueRoutingEntry = Readonly<{
  workerName: string;
  projectId: string;
  queueName: string;
  // HMAC-signed proxy token matching the user worker's __VOID_PROXY_TOKEN
  // binding. The framework-generated /__void/queue handler rejects relays
  // without a matching `x-void-internal` header with 401. Absent on entries
  // written by older API versions.
  proxyToken?: string;
}>;

const CLIENT_REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const STATIC_ASSET_HEDGE_DELAY_MS = 1000;
const PLATFORM_QUEUE_RETRY_DELAY_SECONDS = 300;
// Batches of a project whose owner an administrator suspended wait here. Each
// retry uses one of the queue's max_retries (3 unless the app sets maxRetries),
// so a message survives about one hour per retry, and a queue with maxRetries 0
// drops it on the first suspended delivery. Delivery resumes within about an
// hour of a restore.
const SUSPENDED_PROJECT_QUEUE_RETRY_DELAY_SECONDS = 3600;
// A relay the Worker rejects for its token is retried after the queue routing
// entry (read with cacheTtl 60) has had time to catch up with a token rotation,
// so one rotation costs a message about one attempt instead of all of them.
const QUEUE_TOKEN_REJECTED_RETRY_DELAY_SECONDS = 120;
const PLATFORM_STATIC_ASSET_TIMEOUT: FailureKind = 'platform-static-asset-timeout';
const PLATFORM_STATIC_ASSET_ERROR: FailureKind = 'platform-static-asset-error';
const PLATFORM_STATIC_ASSET_MISSING: FailureKind = 'platform-static-asset-missing';

// How long a STALE ISR entry may keep being served without a successful refresh
// before a background revalidation evicts it. Measured from when the entry became
// STALE (`createdAt + ttl`), NOT from creation — so an entry with a long TTL still
// gets the full grace of STALE tolerance and a transient failure right after expiry
// does not evict immediately. Bounds the "serve stale forever" window for a
// permanently-removed page (origin now 404s and falls back to a non-cacheable shell,
// so the entry can neither refresh nor authoritatively opt-out-evict) while staying
// far above any transient deploy-race 404 so normal stale-while-revalidate is intact.
const ISR_STALE_EVICT_GRACE_SECONDS = 86_400; // 24h of STALE tolerance

/**
 * Whether Cloudflare Access may treat this path as part of the `/health`
 * exception on the platform health hostname. Access covers the subpaths of a
 * destination path. It may see the URL as sent or after the zone's URL
 * normalization, and its handling of case and of prefixes such as `/healthz`
 * is undocumented, so this matches the broadest reading of each.
 */
function platformHealthExceptionPath(request: Request, url: URL): boolean {
  const rawPath = request.url
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/\\?#]*/i, '')
    .replace(/[?#].*$/s, '');
  return [rawPath, url.pathname].some((path) => {
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      // Malformed escapes are matched as sent.
    }
    return decoded
      .replace(/[\\/]+/g, '/')
      .toLowerCase()
      .startsWith('/health');
  });
}

// Fast body-less response for an operation bounded by `withTimeout` that
// stalled past the budget. `X-Void-Timeout` names the stalled operation for
// observability; 503s advertise a short `Retry-After` so clients back off.
function timeoutResponse(status: number, label: string): Response {
  return new Response(null, {
    status,
    headers: {
      'X-Void-Timeout': label,
      ...(status === 503 ? { 'Retry-After': '5' } : {}),
    },
  });
}

function staticAssetFailureResponse(kind: FailureKind): Response {
  if (kind === PLATFORM_STATIC_ASSET_TIMEOUT) {
    return timeoutResponse(503, 'static-asset');
  }
  return new Response(null, {
    status: 503,
    headers: {
      'X-Void-Storage-Error':
        kind === PLATFORM_STATIC_ASSET_MISSING ? 'static-asset-missing' : 'static-asset-read',
      'Retry-After': '5',
    },
  });
}

export function isHtmlResponse(response: Response): boolean {
  return (
    response.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim() === 'text/html'
  );
}

function jsonCacheResponse(pageData: string, ttl: number, state: 'HIT' | 'MISS'): Response {
  const response = new Response(pageData, {
    headers: {
      'content-type': 'application/json',
      'X-VoidPages': 'true',
      Vary: 'X-VoidPages',
      'Cache-Control': `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
      'x-isr-cache': state,
    },
  });
  markSharedCachePolicy(response.headers);
  return response;
}

async function populateJsonEdgeCache(
  cache: Cache,
  cacheKey: Request,
  response: Response,
  ttl: number,
  state: 'HIT' | 'MISS',
): Promise<void> {
  const fromHeader = response.headers.get('x-void-page-data');
  const pageData = fromHeader
    ? normalizePageDataForJsonCache(fromHeader)
    : extractPageDataFromHtml(await response.clone().text());
  if (!pageData) {
    return;
  }
  await cache.put(cacheKey, jsonCacheResponse(pageData, ttl, state));
}

type SharedIsrEntry = Readonly<{
  projectId: string;
  deploymentId: string;
  host: string;
  pathname: string;
  originalUrl?: string;
  htmlKey: Request;
  jsonKey: Request;
}>;

async function deleteSharedIsrEntry(env: Env, entry: SharedIsrEntry): Promise<void> {
  await Promise.all([
    deleteIsrCache(
      env,
      entry.projectId,
      entry.deploymentId,
      entry.host,
      entry.pathname,
      entry.originalUrl,
    ),
    applicationEdgeCache.delete(entry.htmlKey),
    applicationEdgeCache.delete(entry.jsonKey),
  ]);
}

async function applyWorkerFallbackRules(opts: {
  response: Response;
  worker: { fetch(request: Request): Promise<Response> };
  dispatchReq: Request;
  routing: RoutingEntry;
  pathname: string;
  url: URL;
  originalRequestUrl: string;
  originalUrlHeader?: string;
  originalUrlVariant?: string;
  deadline?: Readonly<{ startedAt: number; timeoutMs: number }>;
}): Promise<{
  response: Response;
  pathname: string;
  originalUrlVariant?: string;
  applied: boolean;
}> {
  const unchanged = {
    response: opts.response,
    pathname: opts.pathname,
    originalUrlVariant: opts.originalUrlVariant,
    applied: false,
  };
  if (opts.response.status !== 404 || !opts.routing.fallbackRules?.length) {
    return unchanged;
  }
  if (opts.routing.type === 'void' && opts.response.headers.get('X-Void-No-Match') !== '1') {
    return unchanged;
  }

  const fallback = applyRoutingRules(opts.pathname, opts.routing.fallbackRules, opts.url.hostname);
  if (fallback?.type !== 'rewrite') {
    return unchanged;
  }

  const fallbackHeader = opts.originalUrlHeader ?? opts.originalRequestUrl;
  const originalUrlVariant =
    opts.originalUrlVariant ??
    buildVariantOriginalUrl(opts.originalRequestUrl, opts.pathname, opts.routing.queryAllowlist);
  const fallbackUrl = new URL(opts.url.toString());
  fallbackUrl.pathname = fallback.destination;
  const fallbackRequest = rebuildRequest(opts.dispatchReq, fallbackUrl.toString(), (headers) =>
    headers.set('X-Void-Original-URL', fallbackHeader),
  );

  return {
    response:
      opts.deadline === undefined
        ? await opts.worker.fetch(fallbackRequest)
        : await withTimeout(
            opts.worker.fetch(fallbackRequest),
            remainingTimeoutBudget(opts.deadline.startedAt, opts.deadline.timeoutMs, 'dispatch'),
            'dispatch',
          ),
    pathname: fallback.destination,
    originalUrlVariant,
    applied: true,
  };
}

function buildFallbackOriginalUrlVariant(
  requestUrl: string,
  pathname: string,
  requestHost: string,
  routing: RoutingEntry,
  originalUrlVariant: string | undefined,
): string | undefined {
  // ISR keys a request by its allowlisted query params. A redirect-rule rewrite
  // already built that variant. Fallback rewrites are discovered after the
  // first worker/static miss, but ISR needs the read key before dispatching: if
  // a fallback rule can handle this pathname, use the same original-URL variant
  // a later fallback dispatch would expose via X-Void-Original-URL so
  // query-allowlisted renders cannot collide with the direct ISR key. A direct
  // request keys on its allowlisted params too, and keeps the bare key when it
  // has none.
  if (originalUrlVariant) {
    return originalUrlVariant;
  }
  const variant = buildVariantOriginalUrl(requestUrl, pathname, routing.queryAllowlist);
  const fallback = routing.fallbackRules?.length
    ? applyRoutingRules(pathname, routing.fallbackRules, requestHost)
    : undefined;
  if (fallback?.type === 'rewrite') {
    return variant;
  }
  return new URL(variant).search ? variant : undefined;
}

function resolveCachedWfpFallbackPathname(
  pathname: string,
  routing: RoutingEntry,
  requestHost: string,
): string | undefined {
  const fallback = applyRoutingRules(pathname, routing.fallbackRules, requestHost);
  return fallback?.type === 'rewrite' ? fallback.destination : undefined;
}

// CF's error text for WC-4511 asset dedupe poisoning. Not guaranteed
// stable — monitor fallback telemetry if CF's worker-runtime changes.
const CF_ASSETS_STUB_MARKER = 'Assets have not yet been deployed to this script';

function isLikelyCfAssetStub(response: Response): boolean {
  if (response.status !== 200) {
    return false;
  }
  const contentType = response.headers.get('content-type')?.toLowerCase();
  if (!contentType?.startsWith('text/plain')) {
    return false;
  }
  const contentLengthRaw = response.headers.get('content-length');
  if (!contentLengthRaw) {
    return false;
  }
  const contentLength = Number.parseInt(contentLengthRaw, 10);
  return contentLength > 0 && contentLength < 200;
}

function remainingTimeoutBudget(
  startedAt: number,
  timeoutMs: number,
  label = 'static-asset',
): number {
  if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) {
    return timeoutMs;
  }
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    throw new DispatchTimeoutError(label);
  }
  return remainingMs;
}

function staticAssetHedgeDelayMs(timeoutMs: number): number {
  return timeoutMs > 0 && Number.isFinite(timeoutMs)
    ? Math.min(STATIC_ASSET_HEDGE_DELAY_MS, timeoutMs / 2)
    : 0;
}

async function fetchAssetManifest(
  env: Env,
  deploymentId: string,
  projectId: string,
  timeoutMs: number,
): Promise<Record<string, string> | null> {
  const hedgeDelayMs = staticAssetHedgeDelayMs(timeoutMs);
  try {
    const raw = await withDelayedHedge(
      () => env.ROUTING.get(`manifest:${deploymentId}`, { cacheTtl: 86400 }),
      {
        delayMs: hedgeDelayMs,
        timeoutMs,
        label: 'static-asset',
        onHedge: () => {
          console.warn(
            JSON.stringify({
              event: 'wfp-asset-manifest-read-hedge',
              projectId,
              deploymentId,
              delayMs: hedgeDelayMs,
              ts: Date.now(),
            }),
          );
        },
      },
    );
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as Record<string, string>;
  } catch (error) {
    console.error(
      JSON.stringify({
        event:
          error instanceof DispatchTimeoutError
            ? 'wfp-asset-manifest-timeout'
            : 'wfp-asset-manifest-read-error',
        projectId,
        deploymentId,
        error:
          error instanceof DispatchTimeoutError
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
        ts: Date.now(),
      }),
    );
    if (error instanceof DispatchTimeoutError) {
      throw error;
    }
    throw new StaticAssetReadError(error);
  }
}

// Serve the requested asset from platform R2/KV using the mirror written
// on deploy. Returns null if the routing entry lacks a manifest, the
// manifest is missing from KV, or the path/hash cannot be resolved. The
// caller turns that confirmed poison-stub fallback miss into an attributed
// platform 503 so no successful cache entry can be written.
async function serveWfpAssetFallback(
  env: Env,
  routing: RoutingEntry,
  pathname: string,
  timeoutMs = 10000,
  fallbackPathname?: string,
): Promise<{ response: Response; pathname: string } | null> {
  if (!routing.assetManifestId) {
    return null;
  }
  const startedAt = Date.now();
  const assetManifest = await fetchAssetManifest(
    env,
    routing.assetManifestId,
    routing.projectId,
    remainingTimeoutBudget(startedAt, timeoutMs),
  );
  if (!assetManifest) {
    return null;
  }
  const assetConfig: AssetConfig = routing.assetConfig ?? { not_found_handling: 'none' };
  let resolvedPathname = pathname;
  let resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
  if ((!resolved || resolved.notFound) && fallbackPathname && fallbackPathname !== pathname) {
    const fallbackResolved = resolveStaticPath(fallbackPathname, assetManifest, assetConfig);
    if (fallbackResolved && !fallbackResolved.notFound) {
      resolved = fallbackResolved;
      resolvedPathname = fallbackPathname;
    }
  }
  if (!resolved) {
    return null;
  }
  if (resolved.redirect) {
    return {
      response: new Response(null, {
        status: 308,
        headers: { Location: resolved.redirect },
      }),
      pathname: resolvedPathname,
    };
  }
  const assetResponse = await fetchStaticAsset(
    env,
    resolved.hash,
    resolved.path,
    routing.projectId,
    routing.assetManifestId,
    remainingTimeoutBudget(startedAt, timeoutMs),
  );
  if (!assetResponse) {
    return null;
  }
  return {
    response: new Response(assetResponse.body, {
      status: resolved.notFound ? 404 : 200,
      headers: assetResponse.headers,
    }),
    pathname: resolvedPathname,
  };
}

function logWfpAssetFallback(
  routing: RoutingEntry,
  pathname: string,
  userAgent: string | null,
): void {
  console.log(
    JSON.stringify({
      event: 'wfp-asset-fallback',
      projectId: routing.projectId,
      deploymentId: routing.assetManifestId,
      pathname,
      userAgent,
      ts: Date.now(),
    }),
  );
}

async function maybeServeWfpAssetFallback(opts: {
  env: Env;
  routing: RoutingEntry;
  pathname: string;
  response: Response;
  userAgent: string | null;
  timeoutMs?: number;
  deadline?: Readonly<{ startedAt: number; timeoutMs: number }>;
  fallbackPathname?: string;
}): Promise<{ response: Response; failureKind?: FailureKind; pathname: string }> {
  const startedAt = opts.deadline?.startedAt ?? Date.now();
  const timeoutMs = opts.deadline?.timeoutMs ?? opts.timeoutMs ?? 10000;
  if (isEventStreamResponse(opts.response)) {
    return { response: opts.response, pathname: opts.pathname };
  }
  if (!isLikelyCfAssetStub(opts.response)) {
    return { response: opts.response, pathname: opts.pathname };
  }
  let stubConfirmed = false;
  let fallback: { response: Response; pathname: string } | null;
  try {
    const body = await withTimeout(
      opts.response.clone().text(),
      remainingTimeoutBudget(startedAt, timeoutMs),
      'static-asset',
    );
    if (!body.includes(CF_ASSETS_STUB_MARKER)) {
      return { response: opts.response, pathname: opts.pathname };
    }
    stubConfirmed = true;
    fallback = await serveWfpAssetFallback(
      opts.env,
      opts.routing,
      opts.pathname,
      remainingTimeoutBudget(startedAt, timeoutMs),
      opts.fallbackPathname,
    );
  } catch (error) {
    // Once the CF poison stub is confirmed, never pass its HTTP 200 through:
    // callers may cache successful responses. Surface an attributed platform
    // 503 instead so the failure is retryable without poisoning edge/ISR caches.
    if (error instanceof DispatchTimeoutError) {
      if (!stubConfirmed) {
        return {
          response: timeoutResponse(503, 'dispatch'),
          pathname: opts.pathname,
        };
      }
      return {
        response: staticAssetFailureResponse(PLATFORM_STATIC_ASSET_TIMEOUT),
        failureKind: PLATFORM_STATIC_ASSET_TIMEOUT,
        pathname: opts.pathname,
      };
    }
    if (error instanceof StaticAssetReadError) {
      return {
        response: staticAssetFailureResponse(PLATFORM_STATIC_ASSET_ERROR),
        failureKind: PLATFORM_STATIC_ASSET_ERROR,
        pathname: opts.pathname,
      };
    }
    throw error;
  }
  if (!fallback) {
    console.error(
      JSON.stringify({
        event: 'wfp-asset-fallback-missing',
        projectId: opts.routing.projectId,
        deploymentId: opts.routing.assetManifestId,
        pathname: opts.pathname,
        ts: Date.now(),
      }),
    );
    return {
      response: staticAssetFailureResponse(PLATFORM_STATIC_ASSET_MISSING),
      failureKind: PLATFORM_STATIC_ASSET_MISSING,
      pathname: opts.pathname,
    };
  }
  logWfpAssetFallback(opts.routing, fallback.pathname, opts.userAgent);
  return fallback;
}

/**
 * Rebuild a `Request` with mutated headers, optionally under a new URL.
 * Handles the body-preservation cases we hit at three points in the fetch
 * handler (ingress header-strip, rewrite URL swap, post-ISR dispatch):
 *
 * - Body already consumed/locked: drop body and any stale framing headers
 *   (`content-length` / `transfer-encoding`) — some runtimes reject bodiless
 *   frames that still advertise a framing size.
 * - GET / HEAD: no body to forward; skip the body + duplex dance.
 * - Everything else: forward the streaming body with `duplex: 'half'`.
 */
export function rebuildRequest(
  request: Request,
  url: string,
  mutateHeaders: (headers: Headers) => void,
): Request {
  const headers = new Headers(request.headers);
  mutateHeaders(headers);
  // `cf` (country, colo, botManagement, tlsClientAuth, …) is populated by
  // the CF edge and read by user workers. A plain `new Request(url, init)`
  // does not propagate it; we have to thread it through init.cf explicitly.
  const cfProperties = request.cf;
  if (request.bodyUsed || request.body?.locked) {
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    return new Request(url, { method: request.method, headers, cf: cfProperties });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Request(url, { method: request.method, headers, cf: cfProperties });
  }
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    cf: cfProperties,
    // @ts-expect-error -- duplex required for streaming bodies in CF Workers
    duplex: 'half',
  });
}

const dispatcher = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    privatePreview = false,
  ): Promise<Response> {
    env = await resolvePlatformApplicationEnvironment(env);
    const url = new URL(request.url);
    if (
      !env.PLATFORM_INSTALLATION_ID &&
      url.pathname === '/health' &&
      request.headers.get('X-Health-Check') === 'void-admin'
    ) {
      return Response.json({ ok: true });
    }
    // The installer proves the complete cutover while the public routing gate
    // remains closed. This endpoint exposes no application data and is already
    // reserved for the installer's exact health-check header.
    if (
      env.PLATFORM_HEALTH_PROBE_TOKEN &&
      url.pathname === '/health' &&
      request.headers.get('X-Void-Platform-Probe') === env.PLATFORM_HEALTH_PROBE_TOKEN
    ) {
      return Response.json({
        ok: true,
        ...(env.PLATFORM_APPLICATION ? { installationId: env.PLATFORM_INSTALLATION_ID } : {}),
      });
    }
    // Project Zero Trust leaves `/health` on this hostname outside Cloudflare
    // Access for the probe above. Nothing else on that path may reach a
    // project; every other path stays behind Access and is routed normally.
    if (
      url.hostname.startsWith(`${PLATFORM_HEALTH_HOSTNAME_LABEL}.`) &&
      url.hostname === platformHealthHostname(readPlatformApplication(env)) &&
      platformHealthExceptionPath(request, url)
    ) {
      return createErrorResponse(request, 404, 'Not Found', { 'Cache-Control': 'no-store' });
    }
    if (
      env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
      (env.PLATFORM_INSTALLATION_ID &&
        (await env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE)
    ) {
      return createMaintenanceResponse(request);
    }
    const startTime = Date.now();
    // Keep platform storage/background work bounded. Foreground user workers
    // follow the client's lifetime unless the operator configures a deadline:
    // returning early can cancel a mutation after its external side effect.
    const timeoutMs = resolveTimeoutMs(env.DISPATCH_TIMEOUT_MS);
    const workerTimeoutMs = resolveTimeoutMs(env.DISPATCH_TIMEOUT_MS, 0);

    // Block Void-internal routes from external HTTP access.
    // Only /__void/* is reserved by the platform — other __ prefixes
    // (e.g. /__nuxt_content, /__og-image__) are user/framework assets.
    if (
      url.pathname.startsWith('/__void/') ||
      // Legacy: old SDK versions register these top-level paths. Block them
      // at the edge so we don't rely solely on worker-side token checks.
      // TODO: remove once all deployed workers use /__void/* paths. See #88
      url.pathname === '/__scheduled' ||
      url.pathname === '/__queue'
    ) {
      return createErrorResponse(request, 404, 'Not Found');
    }

    const selected = await resolveProjectHostname(url.hostname, env);
    const slug = selected.slug;
    if (selected.workersDev && !selected.projectId) {
      return createErrorResponse(request, 404, 'Not Found');
    }
    const routingKey = slug ?? `domain:${url.hostname}`;

    let routingRaw = await env.ROUTING.get(privatePreview ? 'preview:' + routingKey : routingKey, {
      cacheTtl: 60,
    });
    let previewRoute = privatePreview;
    if (!routingRaw && !privatePreview && slug?.startsWith('preview-')) {
      routingRaw = await env.ROUTING.get('preview:' + routingKey, { cacheTtl: 60 });
      previewRoute = true;
    }
    if (!routingRaw) {
      return createErrorResponse(request, 404, 'Not Found', {
        'Cache-Control': 'public, max-age=30',
      });
    }

    const routing: RoutingEntry = JSON.parse(routingRaw);
    if (selected.projectId && selected.projectId !== routing.projectId) {
      return createErrorResponse(request, 404, 'Not Found');
    }
    // Keep omission distinct from false so a future platform default can change
    // without overriding an application's explicit opt-out.
    if (routing.alwaysUseHttps ?? false) {
      const redirect = redirectToHttps(request);
      if (redirect) {
        return redirect;
      }
    }
    if (!privatePreview && (routing.privatePreview || previewRoute)) {
      if (!routing.privatePreview || !env.PREVIEW_API) {
        return createErrorResponse(request, 404, 'Not Found', { 'Cache-Control': 'no-store' });
      }
      const headers = new Headers(request.headers);
      headers.set('X-Void-Preview-URL', request.url);
      headers.delete('Authorization');
      return env.PREVIEW_API.fetch(
        new Request('https://preview.invalid/oauth/preview-serve/' + routing.projectId, {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
        }),
      );
    }
    if (Boolean(routing.privatePreview) !== privatePreview) {
      return createErrorResponse(request, 404, 'Not Found', { 'Cache-Control': 'no-store' });
    }

    // Access normally rejects unauthenticated traffic before dispatch. This
    // independent assertion check makes an accidentally deleted or drifted
    // Access application fail closed instead of publishing the project.
    if (
      routing.zeroTrust &&
      !(await projectAccessVerifier.verify(
        url.hostname,
        request.headers.get('Cf-Access-Jwt-Assertion'),
        routing.zeroTrust,
      ))
    ) {
      return createErrorResponse(request, 403, 'Cloudflare Access authentication required', {
        'Cache-Control': 'no-store',
      });
    }

    const limitResponse = (resource: 'requests' | 'execution') =>
      createLimitResponse(
        request,
        {
          code: 'usage_limit',
          resource,
          reason: resource === 'requests' ? 'monthly_quota' : 'cpu',
          message:
            resource === 'requests'
              ? 'This app has reached its usage allowance. Please contact the app owner or try again later.'
              : 'This request exceeded its execution limit. Please try again.',
        },
        async () => {
          const deploymentId = routing.staticDeploymentId ?? routing.assetManifestId;
          if (!deploymentId) {
            return null;
          }
          const path = resource === 'requests' ? '/usage-limit.html' : '/execution-limit.html';
          const manifest = await fetchAssetManifest(env, deploymentId, routing.projectId, 2000);
          const hash = manifest?.[path];
          return hash
            ? fetchStaticAsset(env, hash, path, routing.projectId, deploymentId, 2000)
            : null;
        },
      );

    // Check if project is suspended
    if (routing.suspended === 'requests_exceeded') {
      return limitResponse('requests');
    }
    if (routing.suspended) {
      return Response.json(
        { error: 'usage limit exceeded', reason: routing.suspended },
        { status: 429, headers: { 'Cache-Control': 'public, s-maxage=30, max-age=0' } },
      );
    }

    // Strip any client-supplied X-Void-Original-URL on entry. Dispatch owns this
    // header: the only legitimate source is a dispatch-side rewrite below, which
    // sets it on `workerRequest` with the true original URL. Allowing a client
    // value to flow through would let callers spoof the "original URL" seen by
    // user workers that trust the header.
    if (request.headers.has('X-Void-Original-URL')) {
      request = rebuildRequest(request, request.url, (headers) =>
        headers.delete('X-Void-Original-URL'),
      );
    }
    let pathname = url.pathname;
    let sharedIsrEntry: SharedIsrEntry | undefined;
    let requestType: RequestType =
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? 'websocket' : 'static';

    const meter = (response: Response, failureKind?: FailureKind) => {
      const responseBytes = isEventStreamResponse(response)
        ? 0
        : Number(response.headers.get('content-length') ?? 0);
      recordRequest(env, {
        projectId: routing.projectId,
        type: requestType,
        method: request.method,
        status: response.status,
        responseBytes,
        durationMs: Date.now() - startTime,
        slug: slug ?? url.hostname,
        ...(failureKind && { failureKind }),
      });
      if (routing.userId) {
        ctx.waitUntil(
          sendUsageEvent(env, {
            projectId: routing.projectId,
            userId: routing.userId,
            slug: slug ?? url.hostname,
            requests: 1,
            responseBytes,
            ...(response.status >= 500 && { status: response.status }),
            ...(failureKind && { failureKind }),
          }),
        );
      }
      const res = new Response(response.body, response);
      res.headers.delete('X-Void-No-Match');
      // Cache API and upstream responses have immutable headers. Strip the
      // internal cache marker only from this writable client response.
      res.headers.delete(SHARED_CACHE_POLICY_HEADER);
      res.headers.set('X-Hosted-By', 'void.cloud');
      return res;
    };
    const meterStaticAssetFailure = (kind: FailureKind) =>
      meter(staticAssetFailureResponse(kind), kind);

    // The user's worker blew the dispatch budget. It returned nothing, so it
    // logged nothing, and its own tail event records only `canceled` — which a
    // real client hang-up produces too. Dispatch is the only party that knows
    // it was the one that hung up, so it says so in the project's log stream.
    // Metering is unchanged; this only adds the explanation.
    const meterWorkerTimeout = () => {
      recordPlatformLog(env, {
        workerName: routing.workerName,
        method: request.method,
        url: request.url,
        status: 503,
        timeoutMs: workerTimeoutMs,
      });
      return meter(timeoutResponse(503, 'dispatch'));
    };

    // Routing rules — redirects short-circuit, rewrites modify pathname
    // Two distinct values flow out of a rewrite:
    //   - `originalUrlVariant`: feeds the ISR variant key. Normalized via
    //     `routing.queryAllowlist` so an attacker can't fan out cache slots
    //     by varying `?utm`/`?cb`/etc.
    //   - `originalUrlHeader`: the X-Void-Original-URL surfaced to user
    //     workers for `c.originalUrl()`. Carries the full request URL —
    //     user code expects to see the actual URL the client sent.
    let originalUrlVariant: string | undefined;
    let originalUrlHeader: string | undefined;
    if (routing.redirectRules?.length) {
      const result = applyRoutingRules(pathname, routing.redirectRules, url.hostname);
      if (result?.type === 'redirect') {
        const location = mergeQueryIntoLocation(result.destination, url.search);
        return meter(
          new Response(null, { status: result.status, headers: { Location: location } }),
        );
      }
      if (result?.type === 'rewrite') {
        // Destination shape (path-absolute, no `//`, no `?`) is enforced by
        // the framework validator and re-checked by the API on manifest ingest
        // (see `packages/api/src/routes/deploy.ts`). Dispatch trusts those two
        // gates and does not re-validate here.
        originalUrlHeader = request.url;
        originalUrlVariant = buildVariantOriginalUrl(request.url, pathname, routing.queryAllowlist);
        pathname = result.destination;
        url.pathname = pathname;
      }
    }

    // If rewritten, build the request the worker + ISR should see (rewritten
    // URL + original-URL header).
    let workerRequest = request;
    if (originalUrlHeader) {
      workerRequest = rebuildRequest(request, url.toString(), (headers) =>
        headers.set('X-Void-Original-URL', originalUrlHeader),
      );
    }

    // Edge-cache hashed static assets (immutable, content-addressed URLs)
    if (routing.hashedAssetsPrefix && isSharedStaticCacheRequestEligible(request)) {
      const prefix = '/' + routing.hashedAssetsPrefix + '/';
      if (pathname.startsWith(prefix)) {
        // Cache key tracks the post-rewrite (hash-bearing) URL, not the
        // request URL: hashed entries are stored with a 1-year immutable
        // Cache-Control, so a redirect rule that maps a stable path like
        // /logo to /assets/logo-<hash>.png must not cache content under
        // /logo — a future deploy that points /logo at a different hash
        // would keep serving the stale entry. Strip query: hashed
        // filenames are already content-addressed by their pathname.
        const cacheUrl = new URL(url.toString());
        cacheUrl.search = '';
        // A host can move to another project; immutable entries must not carry over.
        cacheUrl.searchParams.set('_p', routing.projectId);
        const cacheKey = new Request(cacheUrl.toString());

        // Hashed assets are served straight from the immutable edge cache. Apply
        // routing.headerRules on the way OUT — on both cache HIT and MISS — instead
        // of baking them into the cached body. This is what lets a cross-origin
        // isolated app put COOP/COEP/CORP on its hashed worker/wasm assets: browsers
        // fetch those over GET, and without per-serve header application the GET
        // response (unlike a HEAD, which falls through to the worker and is handled
        // by the dispatch path's applyHeaderRules) would ship with no COEP, so a
        // module worker spawned from a require-corp document would be blocked.
        // Applying per-serve rather than at cache-write also means a header-rule
        // change in a later deploy takes effect even when the content hash — and
        // thus the unversioned, immutable cache key — is unchanged.
        //
        // Tenant rules apply ADDITIVELY only. The platform/origin owns how a
        // content-addressed asset is cached, represented, and framed on the wire;
        // tenants may ADD headers (COOP/COEP/CORP, security) but must not rewrite
        // the headers below, so each is restored from the pre-rule response after
        // the rules run. The set is exactly the headers whose forgery would corrupt
        // the asset or break the immutable-cache / usage-metering contract:
        //   cache-control     immutable contract; the cache-HIT check above keys on it
        //   content-type      wrong MIME breaks ES-module / WebAssembly loading
        //   content-encoding  a false `gzip` makes the browser mis-decode the bytes
        //   content-length    meter() bills from it; clients frame the body by it
        //   content-range     } forging range/framing semantics truncates or
        //   accept-ranges     } mis-reads a body the platform did not range-encode
        //   transfer-encoding hop-by-hop framing; must never come from a tenant rule
        // Cosmetic metadata (Vary, ETag, ...) is left overridable — on an immutable
        // URL-keyed asset it is neither a corruption nor a security risk. This
        // mirrors how the static-asset paths force their own Cache-Control after
        // applyHeaderRules via clientRevalidateResponse.
        const MANAGED_ASSET_HEADERS = [
          'cache-control',
          'content-type',
          'content-encoding',
          'content-length',
          'content-range',
          'accept-ranges',
          'transfer-encoding',
        ] as const;
        const finalizeAsset = (assetResponse: Response, failureKind?: FailureKind): Response => {
          const ruled = applyHeaderRules(assetResponse, pathname, routing.headerRules);
          // applyHeaderRules returns the same object when nothing matched — then
          // there is no override to undo and we can skip the header restore.
          if (ruled !== assetResponse) {
            for (const name of MANAGED_ASSET_HEADERS) {
              const managed = assetResponse.headers.get(name);
              if (managed === null) {
                ruled.headers.delete(name);
              } else {
                ruled.headers.set(name, managed);
              }
            }
          }
          return meter(ruled, failureKind);
        };

        const cache = applicationEdgeCache;
        const cached = await cache.match(cacheKey);
        if (
          cached?.headers.get('Cache-Control')?.includes('immutable') &&
          isCurrentStaticCacheResponse(cached)
        ) {
          if (!routing.staticDeploymentId) {
            const repairResult = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response: cached,
              userAgent: request.headers.get('user-agent'),
              timeoutMs,
            });
            if (repairResult.response !== cached) {
              if (isStaticCacheResponseEligible(repairResult.response)) {
                const repaired = new Response(repairResult.response.body, repairResult.response);
                repaired.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
                markSharedCachePolicy(repaired.headers);
                const repairedForCache = repaired.clone();
                ctx.waitUntil(
                  cache.delete(cacheKey).then(() => cache.put(cacheKey, repairedForCache)),
                );
                return finalizeAsset(repaired, repairResult.failureKind);
              }
              ctx.waitUntil(cache.delete(cacheKey));
              return finalizeAsset(repairResult.response, repairResult.failureKind);
            }
          }
          return finalizeAsset(cached);
        }
        if (cached) {
          await cache.delete(cacheKey);
        }
        // Cache miss — fetch from KV/R2 for static deployments, or invoke worker
        if (routing.staticDeploymentId) {
          const staticAssetStartedAt = Date.now();
          let assetManifest: Record<string, string> | null;
          try {
            assetManifest = await fetchAssetManifest(
              env,
              routing.staticDeploymentId,
              routing.projectId,
              remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
            );
          } catch (err) {
            if (err instanceof DispatchTimeoutError) {
              return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
            }
            if (err instanceof StaticAssetReadError) {
              return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
            }
            throw err;
          }
          if (!assetManifest) {
            return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
          }
          // Manifest keys are decoded on-disk paths, but `pathname` stays
          // percent-encoded. Try the raw key, then the decoded key (e.g. a
          // hashed file named `oxc masthead.riv` requested as `oxc%20masthead.riv`).
          let assetPath = pathname;
          let hash = assetManifest[pathname];
          if (!hash) {
            const decoded = safeDecodePathname(pathname);
            if (decoded !== pathname && assetManifest[decoded]) {
              assetPath = decoded;
              hash = assetManifest[decoded];
            }
          }
          let response: Response;
          if (hash) {
            try {
              const assetResponse = await fetchStaticAsset(
                env,
                hash,
                assetPath,
                routing.projectId,
                routing.staticDeploymentId,
                remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
              );
              if (!assetResponse) {
                logStaticAssetMissing(routing, assetPath, hash);
                return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
              }
              response = assetResponse;
            } catch (err) {
              // No `resolved.notFound` in scope on this hashed-asset branch — a
              // storage failure is always a real asset read, so fast 503.
              if (err instanceof DispatchTimeoutError) {
                return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
              }
              if (err instanceof StaticAssetReadError) {
                return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
              }
              throw err;
            }
          } else {
            response = createErrorResponse(request, 404, 'Not Found');
          }
          if (isStaticCacheResponseEligible(response)) {
            const res = new Response(response.body, response);
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            markSharedCachePolicy(res.headers);
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return finalizeAsset(res);
          }
          return finalizeAsset(response);
        }
        try {
          const worker = getWorker(env, routing);
          const wfpAssetStartedAt = Date.now();
          let response = await withTimeout(
            worker.fetch(workerRequest),
            remainingTimeoutBudget(wfpAssetStartedAt, timeoutMs),
            'static-asset',
          );
          // Safety net for CF asset dedupe poisoning (WC-4511). See
          // meta/design-docs/0066. Detection only triggers on the CF
          // stub's fingerprint; all other responses stream through.
          const fallbackResult = await maybeServeWfpAssetFallback({
            env,
            routing,
            pathname,
            response,
            userAgent: request.headers.get('user-agent'),
            deadline: { startedAt: wfpAssetStartedAt, timeoutMs },
          });
          response = fallbackResult.response;
          const failureKind = fallbackResult.failureKind;
          if (isStaticCacheResponseEligible(response)) {
            const res = new Response(response.body, response);
            res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
            markSharedCachePolicy(res.headers);
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return finalizeAsset(res, failureKind);
          }
          return finalizeAsset(response, failureKind);
        } catch (err) {
          if (err instanceof DispatchTimeoutError) {
            return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
          }
          if (err instanceof Error && err.message.includes('Worker exceeded')) {
            return meter(await limitResponse('execution'));
          }
          throw err;
        }
      }
    }

    // ISR: stale-while-revalidate for configured paths
    // Two-layer cache: Edge (per-colo) → KV → Worker (render)
    // Pages protocol (X-VoidPages) uses a separate JSON edge cache; HTML uses KV+edge.
    // ISR applies to SSR page paths only. An API route or an asset-extension
    // path that happens to match a catch-all page pattern must render live and
    // never enter the ISR cache — mirrors the write-back path check below and
    // how meta-frameworks resolve API routes to non-ISR outputs.
    const isSsrPath =
      routing.ssr === true &&
      (routing.type !== 'framework' || isFrameworkDocumentRequest(request)) &&
      isIsrEligiblePath(pathname, routing.pages, routing.revalidate, routing.pathRevalidate);
    if (isSsrPath && (routing.revalidate || routing.pages?.length)) {
      const isrTtl = resolvePageTtl(
        routing.pages,
        routing.revalidate,
        routing.pathRevalidate,
        pathname,
      );
      // Range requests must render LIVE so the origin produces a correct partial
      // response (`206 Partial Content`) for the requested byte range. They must
      // never read the shared ISR entry (a full body for a partial request) nor
      // write it (a truncated 206 that a later full request would then be served),
      // so bail out of the ISR ladder entirely before any cache read or write.
      if (
        isrTtl > 0 &&
        request.method === 'GET' &&
        !request.headers.has('Range') &&
        !shouldBypassIsr(request)
      ) {
        const isPagesRequest = request.headers.has('X-VoidPages');
        const isrDeploymentId = routing.version ?? 'legacy';
        const cache = applicationEdgeCache;
        const isrOriginalUrlVariant = buildFallbackOriginalUrlVariant(
          request.url,
          pathname,
          url.hostname,
          routing,
          originalUrlVariant,
        );
        // The key drops these params, but a render may still read them. Never
        // store such a render under the shared key. Match the allowlist on the
        // pre-rewrite path, as the rewrite variant does.
        const unlisted = hasUnlistedQueryParams(
          request.url,
          new URL(request.url).pathname,
          routing.queryAllowlist,
        );
        const cacheKey = isrEdgeCacheKey(request, pathname, isrDeploymentId, isrOriginalUrlVariant);
        const jsonCacheKey = isrEdgeCacheKeyJson(
          request,
          pathname,
          isrDeploymentId,
          isrOriginalUrlVariant,
        );
        sharedIsrEntry = {
          projectId: routing.projectId,
          deploymentId: isrDeploymentId,
          host: url.hostname,
          pathname,
          originalUrl: isrOriginalUrlVariant,
          htmlKey: cacheKey,
          jsonKey: jsonCacheKey,
        };

        // Pages protocol: check JSON edge cache, fall through on miss
        if (isPagesRequest) {
          const jsonCached = await cache.match(jsonCacheKey);
          if (jsonCached && hasCurrentSharedCachePolicy(jsonCached)) {
            requestType = 'isr';
            return meter(clientRevalidateResponse(jsonCached));
          }
          if (jsonCached) {
            await cache.delete(jsonCacheKey);
          }
          // Miss — fall through to general dispatch (worker returns JSON for X-VoidPages)
        } else {
          // HTML path: Edge → KV → Worker
          const purgePoisonedIsrEntry = async (): Promise<void> => {
            await deleteSharedIsrEntry(env, sharedIsrEntry!);
          };

          // L1: Edge cache (per-colo)
          const edgeCached = await cache.match(cacheKey);
          if (edgeCached && hasCurrentSharedCachePolicy(edgeCached)) {
            requestType = 'isr';
            const repairResult = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response: edgeCached,
              userAgent: request.headers.get('user-agent'),
              timeoutMs,
              fallbackPathname: resolveCachedWfpFallbackPathname(pathname, routing, url.hostname),
            });
            if (repairResult.response !== edgeCached) {
              ctx.waitUntil(purgePoisonedIsrEntry());
              return meter(
                repairResult.response.ok
                  ? clientRevalidateResponse(repairResult.response)
                  : repairResult.response,
                repairResult.failureKind,
              );
            }
            return meter(clientRevalidateResponse(edgeCached));
          }
          if (edgeCached) {
            await cache.delete(cacheKey);
          }

          // L2: KV
          const cached = await readIsrCache(
            env,
            routing.projectId,
            isrDeploymentId,
            url.hostname,
            pathname,
            isrOriginalUrlVariant,
          );
          if (cached) {
            const stale = isStale(cached);
            const cacheResponse = isrCacheResponse(cached, stale);
            const repairResult = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response: cacheResponse,
              userAgent: request.headers.get('user-agent'),
              timeoutMs,
              fallbackPathname: resolveCachedWfpFallbackPathname(pathname, routing, url.hostname),
            });
            if (repairResult.response !== cacheResponse) {
              ctx.waitUntil(purgePoisonedIsrEntry());
              requestType = 'isr';
              return meter(
                repairResult.response.ok
                  ? clientRevalidateResponse(repairResult.response)
                  : repairResult.response,
                repairResult.failureKind,
              );
            }
            if (stale) {
              const staleCacheResponse = cacheResponse.clone();
              // Refresh from the key's own URL, not the triggering one.
              let revalidateRequest = workerRequest;
              if (unlisted) {
                const keyUrl = new URL(workerRequest.url);
                keyUrl.search = isrOriginalUrlVariant ? new URL(isrOriginalUrlVariant).search : '';
                revalidateRequest = rebuildRequest(workerRequest, keyUrl.toString(), (headers) => {
                  if (originalUrlHeader && isrOriginalUrlVariant) {
                    headers.set('X-Void-Original-URL', isrOriginalUrlVariant);
                  }
                });
              }
              ctx.waitUntil(
                revalidateInBackground(
                  env,
                  routing,
                  revalidateRequest,
                  url.hostname,
                  pathname,
                  isrTtl,
                  cacheKey,
                  jsonCacheKey,
                  cached.createdAt + cached.ttl * 1000,
                  isrOriginalUrlVariant,
                  timeoutMs,
                ).then(async (sharedEntryChanged) => {
                  if (!sharedEntryChanged) {
                    await cache.put(cacheKey, staleCacheResponse);
                  }
                }),
              );
            }
            requestType = 'isr';
            if (!stale) {
              ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));
            }
            return meter(clientRevalidateResponse(cacheResponse));
          }

          // Cache miss: render via worker, cache in background
          requestType = 'isr';
          const worker = getWorker(env, routing);
          const isrWorkerStartedAt = Date.now();
          const isrWorkerDeadline =
            env.DISPATCH_TIMEOUT_MS === undefined
              ? undefined
              : { startedAt: isrWorkerStartedAt, timeoutMs: workerTimeoutMs };
          let workerResponse: Response;
          try {
            workerResponse = await withTimeout(
              worker.fetch(workerRequest),
              remainingTimeoutBudget(isrWorkerStartedAt, workerTimeoutMs, 'dispatch'),
              'dispatch',
            );
          } catch (error) {
            if (error instanceof DispatchTimeoutError) {
              return meterWorkerTimeout();
            }
            throw error;
          }
          let isWorkerEventStream = isEventStreamResponse(workerResponse);
          let workerResponseFailureKind: FailureKind | undefined;
          // The pathname the ISR write is effectively for. A fallback rewrite can
          // turn a page 404 into a 200 from `/api/*` — a dynamic body that must
          // never be cached under the original page URL. `fallbackResult` is
          // block-scoped below, so capture its post-fallback pathname AND whether a
          // fallback fired here (the write gate needs both, out of that scope).
          let effectiveMissPathname = pathname;
          let missFallbackApplied = false;
          if (!isWorkerEventStream) {
            const assetFallbackResult = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response: workerResponse,
              userAgent: request.headers.get('user-agent'),
              deadline: isrWorkerDeadline,
            });
            workerResponse = assetFallbackResult.response;
            workerResponseFailureKind = assetFallbackResult.failureKind;
            isWorkerEventStream = isEventStreamResponse(workerResponse);
          }
          if (!isWorkerEventStream) {
            let fallbackResult: Awaited<ReturnType<typeof applyWorkerFallbackRules>>;
            try {
              fallbackResult = await applyWorkerFallbackRules({
                response: workerResponse,
                worker,
                dispatchReq: workerRequest,
                routing,
                pathname,
                url,
                originalRequestUrl: request.url,
                originalUrlHeader,
                originalUrlVariant: isrOriginalUrlVariant,
                deadline: isrWorkerDeadline,
              });
            } catch (error) {
              if (error instanceof DispatchTimeoutError) {
                return meterWorkerTimeout();
              }
              throw error;
            }
            if (fallbackResult.applied) {
              missFallbackApplied = true;
              effectiveMissPathname = fallbackResult.pathname;
              workerResponse = fallbackResult.response;
              isWorkerEventStream = isEventStreamResponse(workerResponse);
              if (!isWorkerEventStream) {
                const assetFallbackResult = await maybeServeWfpAssetFallback({
                  env,
                  routing,
                  pathname: fallbackResult.pathname,
                  response: workerResponse,
                  userAgent: request.headers.get('user-agent'),
                  deadline: isrWorkerDeadline,
                });
                workerResponse = assetFallbackResult.response;
                workerResponseFailureKind = assetFallbackResult.failureKind;
                isWorkerEventStream = isEventStreamResponse(workerResponse);
              }
            }
          }
          if (isWorkerEventStream) {
            return meter(workerResponse);
          }
          const ttl = resolveRevalidateTtl(workerResponse, isrTtl);
          // Only a full 200 may enter the shared full-response cache. `.ok` is
          // 200–299 (INCLUDING 206 Partial Content), which would poison the entry.
          // Also gate on the POST-fallback pathname: a fallback that rewrote the
          // page 404 into a 200 from `/api/*` must never be cached under the
          // original page URL (an `/api` body is per-request dynamic). Never cache
          // a response that DECLARES itself uncacheable via Cache-Control
          // (private/no-store/no-cache). Finally — the shared-cache-safety gate —
          // when a FALLBACK was APPLIED the render may enter the ORIGINAL page key
          // ONLY when the fallback TARGET is the WINNING EXACT declared literal ISR
          // page AND the render is HTML (see `isFallbackTargetCacheable`). Any other
          // target — a dotted `text/html` shell (`/account.html`), an undeclared
          // extensionless target (e.g. `/* → /graphql`), a catch-all/param page
          // match — is INDISTINGUISHABLE here from a per-user dynamic endpoint, so it
          // is NOT shared-cached (it is still SERVED live). Positive identification —
          // never the mere ABSENCE of an opt-out header — is required: a
          // user-configured rewrite to a private endpoint must not be able to poison
          // the page key just by omitting Cache-Control.
          if (
            !unlisted &&
            ttl > 0 &&
            workerResponse.status === 200 &&
            (routing.type !== 'framework' || isHtmlResponse(workerResponse)) &&
            !isApiPath(effectiveMissPathname) &&
            !hasSharedCacheOptOut(workerResponse) &&
            (!missFallbackApplied ||
              isFallbackTargetCacheable(
                routing.pages,
                effectiveMissPathname,
                workerResponse,
                routing.pathRevalidate,
              ))
          ) {
            ctx.waitUntil(
              writeIsrCache(
                env,
                routing.projectId,
                isrDeploymentId,
                url.hostname,
                pathname,
                workerResponse,
                ttl,
                isrOriginalUrlVariant,
              ),
            );
            ctx.waitUntil(populateJsonEdgeCache(cache, jsonCacheKey, workerResponse, ttl, 'HIT'));
            const cacheHeaders = new Headers(workerResponse.headers);
            cacheHeaders.set(
              'Cache-Control',
              `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
            );
            cacheHeaders.set('x-isr-cache', 'MISS');
            markSharedCachePolicy(cacheHeaders);
            cacheHeaders.delete('x-void-page-data');
            cacheHeaders.delete('set-cookie');
            // Later requests read this copy from the edge, so it is stored as a HIT;
            // only this client response reports the MISS.
            const edgeHeaders = new Headers(cacheHeaders);
            edgeHeaders.set('x-isr-cache', 'HIT');
            const cacheResponse = new Response(workerResponse.clone().body, {
              status: workerResponse.status,
              headers: edgeHeaders,
            });
            ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));

            const clientHeaders = new Headers(cacheHeaders);
            clientHeaders.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
            clientHeaders.delete(SHARED_CACHE_POLICY_HEADER);
            const clientResponse = new Response(workerResponse.body, {
              status: workerResponse.status,
              headers: clientHeaders,
            });
            return meter(clientResponse, workerResponseFailureKind);
          }
          if (
            workerResponse.status === 200 &&
            !missFallbackApplied &&
            (ttl === 0 ||
              hasSharedCacheOptOut(workerResponse) ||
              (routing.type === 'framework' && !isHtmlResponse(workerResponse)))
          ) {
            ctx.waitUntil(purgePoisonedIsrEntry());
          }
          return meter(workerResponse, workerResponseFailureKind);
        }
      }
    }

    // Edge-cache non-hashed static assets using deploy-versioned cache keys.
    // The same request gate feeds both cache reads and writes. Credentialed,
    // Range, and Pages-protocol requests must reach the worker instead of a
    // shared representation. For SSR deployments, a dotted path is only a
    // candidate when the emitted asset manifest positively identifies it.
    const staticCachePathname = pathname;
    // `false` only when this SSR deploy's asset manifest was read and no asset
    // answers the path. Metering reuses it to label app routes.
    const knownStaticAsset = isStaticCacheRequestEligible(request, staticCachePathname, routing)
      ? await isKnownStaticAssetPath(env, staticCachePathname, routing, timeoutMs)
      : undefined;
    const isStaticCandidate = knownStaticAsset === true;

    let staticCacheKey: Request | undefined;
    if (isStaticCandidate) {
      // Project allowlisted query params into the key so a dynamic extensioned
      // route whose body depends on the query (e.g. an image/badge endpoint that
      // declares `queryAllowlist`) caches per-variant instead of collapsing to the
      // first render. Only EXACT (wildcard-free) allowlist patterns opt in: this
      // static-candidate cache has no per-path variant cap (unlike ISR), so a broad
      // `*` / prefix-wildcard entry here could let a cache-buster query fan out
      // true static assets. `buildVariantOriginalUrl` drops the query entirely when
      // no pattern matches, so a route with no exact match keeps its pathname-only
      // key — unchanged behavior. The allowlist is authored against the user-facing
      // path, so match on the original request pathname (a rewrite above may have
      // reassigned `pathname` to a destination).
      const cacheUrl = new URL(
        buildVariantOriginalUrl(
          request.url,
          new URL(request.url).pathname,
          exactQueryAllowlist(routing.queryAllowlist),
        ),
      );
      cacheUrl.searchParams.set('_v', String(routing.version));
      const candidateCacheKey = new Request(cacheUrl.toString());
      staticCacheKey = candidateCacheKey;
      const staticCache = applicationEdgeCache;
      const cached = await staticCache.match(candidateCacheKey);
      if (cached && isCurrentStaticCacheResponse(cached)) {
        requestType = 'static';
        if (!routing.staticDeploymentId) {
          const repairResult = await maybeServeWfpAssetFallback({
            env,
            routing,
            pathname,
            response: cached,
            userAgent: request.headers.get('user-agent'),
            timeoutMs,
            fallbackPathname: resolveCachedWfpFallbackPathname(pathname, routing, url.hostname),
          });
          if (repairResult.response !== cached) {
            if (isStaticCacheResponseEligible(repairResult.response)) {
              const finalRes = applyHeaderRules(
                repairResult.response,
                repairResult.pathname,
                routing.headerRules,
              );
              const repaired = new Response(finalRes.clone().body, finalRes);
              repaired.headers.set(
                'Cache-Control',
                'public, s-maxage=31536000, max-age=0, must-revalidate',
              );
              markSharedCachePolicy(repaired.headers);
              const repairedForCache = repaired.clone();
              ctx.waitUntil(
                staticCache
                  .delete(candidateCacheKey)
                  .then(() => staticCache.put(candidateCacheKey, repairedForCache)),
              );
              return meter(clientRevalidateResponse(finalRes));
            }
            ctx.waitUntil(staticCache.delete(candidateCacheKey));
            return meter(repairResult.response, repairResult.failureKind);
          }
        }
        return meter(clientRevalidateResponse(cached));
      }
      if (cached) {
        // Entries written by older dispatch versions may contain an unverified
        // dynamic response. Do not serve it, and remove it opportunistically.
        await staticCache.delete(candidateCacheKey);
      }
    }

    // KV/R2-backed static serving — no WfP worker needed
    if (routing.staticDeploymentId) {
      const staticAssetStartedAt = Date.now();
      let assetManifest: Record<string, string> | null;
      try {
        assetManifest = await fetchAssetManifest(
          env,
          routing.staticDeploymentId,
          routing.projectId,
          remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
        );
      } catch (err) {
        if (err instanceof DispatchTimeoutError) {
          return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
        }
        if (err instanceof StaticAssetReadError) {
          return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
        }
        throw err;
      }
      if (!assetManifest) {
        return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
      }
      const assetConfig: AssetConfig = routing.assetConfig ?? {};

      // Capture pathname before the fallback rewrite potentially mutates it.
      // The edge cache must be keyed on the path seen here (what the client
      // requested, post any pre-asset rewrites), not the rewrite target —
      // otherwise future requests to this path miss the cache entry.
      const fallbackOriginPathname = pathname;
      let resolved = resolveStaticPath(pathname, assetManifest, assetConfig);

      // Fallback rules run on an asset miss, before serving a custom 404 page.
      // Single-pass: re-resolve with rewritten path, no further fallbacks.
      // `fallbackRules` are status-200-only (enforced at API ingest), so
      // `applyRoutingRules` only ever yields `type: 'rewrite'` here.
      if ((!resolved || resolved.notFound) && routing.fallbackRules?.length) {
        const fallback = applyRoutingRules(pathname, routing.fallbackRules, url.hostname);
        if (fallback?.type === 'rewrite') {
          // Same trust model as the redirectRules rewrite above — framework +
          // API both validate destination shape before the manifest lands here.
          pathname = fallback.destination;
          url.pathname = pathname;
          resolved = resolveStaticPath(pathname, assetManifest, assetConfig);
        }
      }

      if (!resolved) {
        return meter(createErrorResponse(request, 404, 'Not Found'));
      }

      if (resolved.redirect) {
        return meter(
          new Response(null, {
            status: 308,
            headers: { Location: resolved.redirect },
          }),
        );
      }

      let assetResponse: Response | null;
      try {
        assetResponse = await fetchStaticAsset(
          env,
          resolved.hash,
          resolved.path,
          routing.projectId,
          routing.staticDeploymentId,
          remainingTimeoutBudget(staticAssetStartedAt, timeoutMs),
        );
      } catch (err) {
        // A stalled read of the not-found asset was always going to 404, so
        // return a fast 404 (must not trip the 5xx alert); a real asset read
        // that stalled → fast 503.
        if (err instanceof DispatchTimeoutError) {
          return meter(
            timeoutResponse(resolved.notFound ? 404 : 503, 'static-asset'),
            resolved.notFound ? undefined : PLATFORM_STATIC_ASSET_TIMEOUT,
          );
        }
        if (err instanceof StaticAssetReadError) {
          return meter(
            resolved.notFound
              ? createErrorResponse(request, 404, 'Not Found')
              : staticAssetFailureResponse(PLATFORM_STATIC_ASSET_ERROR),
            resolved.notFound ? undefined : PLATFORM_STATIC_ASSET_ERROR,
          );
        }
        throw err;
      }
      if (!assetResponse) {
        if (resolved.notFound) {
          return meter(createErrorResponse(request, 404, 'Not Found'));
        }
        logStaticAssetMissing(routing, resolved.path, resolved.hash);
        return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_MISSING);
      }

      const status = resolved.notFound ? 404 : 200;
      const response = new Response(assetResponse.body, {
        status,
        headers: assetResponse.headers,
      });
      const finalRes = applyHeaderRules(response, pathname, routing.headerRules);

      // Populate edge cache (same pattern as existing deploy-versioned static cache).
      // Key on the ORIGINAL pathname the client requested, not the post-fallback
      // rewrite target — otherwise future requests to the original path miss.
      const edgeCacheKey =
        staticCacheKey ??
        (isSharedStaticCacheRequestEligible(request)
          ? new Request(`${url.origin}${fallbackOriginPathname}?_v=${routing.staticDeploymentId}`)
          : undefined);
      if (edgeCacheKey && isStaticCacheResponseEligible(finalRes)) {
        const cached = new Response(finalRes.clone().body, finalRes);
        cached.headers.set(
          'Cache-Control',
          'public, s-maxage=31536000, max-age=0, must-revalidate',
        );
        markSharedCachePolicy(cached.headers);
        ctx.waitUntil(applicationEdgeCache.put(edgeCacheKey, cached.clone()));
      }

      return meter(clientRevalidateResponse(finalRes));
    }

    // Dispatch to user worker — CF handles static assets transparently
    const worker = getWorker(env, routing);
    try {
      let dispatchReq = workerRequest;
      if (dispatchReq.bodyUsed) {
        dispatchReq = rebuildRequest(dispatchReq, dispatchReq.url, () => {});
      }
      // If a worker-backed fallbackRule could fire on a 404, the inner
      // re-dispatch needs the original body — but `worker.fetch` consumes
      // the body stream and `rebuildRequest` on a `bodyUsed` request drops
      // it (silently). Clone here so the fallback path has a replayable
      // copy. `Request.clone()` tees the stream on CF Workers. Skip the
      // clone when there are no fallback rules or the method has no body
      // (GET/HEAD) — the common case stays free.
      const hasBodyMethod = dispatchReq.method !== 'GET' && dispatchReq.method !== 'HEAD';
      const dispatchReqForFallback =
        hasBodyMethod && routing.fallbackRules?.length ? dispatchReq.clone() : dispatchReq;
      const workerDispatchStartedAt = Date.now();
      const workerDeadline =
        env.DISPATCH_TIMEOUT_MS === undefined
          ? undefined
          : { startedAt: workerDispatchStartedAt, timeoutMs: workerTimeoutMs };
      let response = await withTimeout(
        worker.fetch(dispatchReq),
        remainingTimeoutBudget(workerDispatchStartedAt, workerTimeoutMs, 'dispatch'),
        'dispatch',
      );
      let isEventStream = isEventStreamResponse(response);
      let responseFailureKind: FailureKind | undefined;

      // Safety net for CF asset dedupe poisoning (WC-4511). See
      // meta/design-docs/0066. Pre-check gates body read so non-asset
      // responses stream through untouched.
      if (!isEventStream) {
        const assetFallbackResult = await maybeServeWfpAssetFallback({
          env,
          routing,
          pathname,
          response,
          userAgent: request.headers.get('user-agent'),
          deadline: workerDeadline,
        });
        response = assetFallbackResult.response;
        responseFailureKind = assetFallbackResult.failureKind;
        isEventStream = isEventStreamResponse(response);
      }

      // routing.fallbackRules — for static deployments these fire post-asset.
      // The user worker is the equivalent path resolver here, so
      // a 404 is the analogue of a static-asset miss. Single-pass: the
      // rewrite target's response is returned as-is even if it's also 404.
      //
      // `fallbackResult` is block-scoped below, but the ISR write-back gate
      // needs to know whether a fallback fired (the fallback-target positive-ID
      // check). Hoist the flag out here — mirrors the miss-write's
      // `missFallbackApplied`.
      let writebackFallbackApplied = false;
      if (!isEventStream) {
        const fallbackResult = await applyWorkerFallbackRules({
          response,
          worker,
          dispatchReq: dispatchReqForFallback,
          routing,
          pathname,
          url,
          originalRequestUrl: request.url,
          originalUrlHeader,
          originalUrlVariant,
          deadline: workerDeadline,
        });
        if (fallbackResult.applied) {
          writebackFallbackApplied = true;
          pathname = fallbackResult.pathname;
          url.pathname = pathname;
          originalUrlVariant = fallbackResult.originalUrlVariant;
          response = fallbackResult.response;
          isEventStream = isEventStreamResponse(response);
          if (!isEventStream) {
            const assetFallbackResult = await maybeServeWfpAssetFallback({
              env,
              routing,
              pathname,
              response,
              userAgent: request.headers.get('user-agent'),
              deadline: workerDeadline,
            });
            response = assetFallbackResult.response;
            responseFailureKind = assetFallbackResult.failureKind;
            isEventStream = isEventStreamResponse(response);
          }
        }
      }

      if (
        sharedIsrEntry &&
        response.status === 200 &&
        !writebackFallbackApplied &&
        (resolveRevalidateTtl(
          response,
          resolvePageTtl(
            routing.pages,
            routing.revalidate,
            routing.pathRevalidate,
            sharedIsrEntry.pathname,
          ),
        ) === 0 ||
          hasSharedCacheOptOut(response) ||
          (routing.type === 'framework' && !isHtmlResponse(response)))
      ) {
        ctx.waitUntil(deleteSharedIsrEntry(env, sharedIsrEntry));
      }

      // Cache static asset at edge if eligible. Require a full 200 — `.ok` is
      // 200–299 and would admit a `206 Partial Content` (a Range request to a
      // dotted SSR path skips the ISR ladder and falls through here), poisoning
      // the shared `<path>?_v=` key with a partial body that a later full request
      // could then be served. Mirrors the `status === 200` guard at the ISR sites.
      if (staticCacheKey && !writebackFallbackApplied && isStaticCacheResponseEligible(response)) {
        const res = new Response(response.body, response);
        res.headers.delete('x-void-page-data');
        const finalRes = applyHeaderRules(res, pathname, routing.headerRules);
        const cacheRes = new Response(finalRes.clone().body, finalRes);
        cacheRes.headers.set(
          'Cache-Control',
          'public, s-maxage=31536000, max-age=0, must-revalidate',
        );
        markSharedCachePolicy(cacheRes.headers);
        ctx.waitUntil(applicationEdgeCache.put(staticCacheKey, cacheRes.clone()));
        return meter(clientRevalidateResponse(finalRes), responseFailureKind);
      }

      // Classify for metering. A path with a file extension is the app's only when
      // the worker, not Cloudflare's asset layer, answered it, and either the
      // manifest answer for this exact path says it is not a deployed file or the
      // response is a server error. Platform asset failures carry a failure kind
      // and keep the default.
      const listedAsset = pathname === staticCachePathname ? knownStaticAsset : undefined;
      const handledByApp =
        !responseFailureKind &&
        workerAnsweredPath(routing, listedAsset) &&
        (listedAsset === false || response.status >= 500);
      const dynamicType = classifyDynamicRequestType(pathname, routing.ssr, handledByApp);
      if (dynamicType) {
        requestType = dynamicType;
      }

      // Write ISR cache on miss — skip pages protocol responses (JSON, not HTML)
      // Guard: only cache GET requests without credentials, and respect worker x-revalidate
      // Range requests are excluded here too: a partial (206) response must never
      // be written into the shared full-response ISR cache. Mirrors the ISR-ladder
      // guard above.
      if (
        (routing.revalidate || routing.pages?.length) &&
        !isEventStream &&
        !request.headers.has('X-VoidPages') &&
        request.method === 'GET' &&
        !request.headers.has('Range') &&
        (routing.type !== 'framework' || isFrameworkDocumentRequest(request)) &&
        !shouldBypassIsr(request)
      ) {
        const configTtl = resolvePageTtl(
          routing.pages,
          routing.revalidate,
          routing.pathRevalidate,
          pathname,
        );
        // Config TTL is the gatekeeper — worker x-revalidate can reduce but not enable ISR
        const isrTtl = configTtl > 0 ? resolveRevalidateTtl(response, configTtl) : 0;
        // Only a full 200 is cacheable — `.ok` (200–299) would let a 206 poison the entry.
        // `pathname` is the POST-fallback pathname, so the SSR path check below
        // already skips a fallback that rewrote to `/api` — the same `/api` exclusion
        // the miss-write and background-revalidation sites spell out with
        // `!isApiPath(effective…)`. (This SSR-path gate is stricter than those two:
        // it also skips extension targets, but requests reaching this branch are not
        // the ssr+revalidate ISR-ladder path where SPA `/index.html` fallbacks cache.)
        // A path with a file extension never enters the ISR cache here, even when
        // metering labels it `ssr` because the app's own route answered.
        //
        // Fallback positive-ID gate — the same one the miss-write and background sites
        // enforce: when a FALLBACK rewrote this request, the render may enter the shared
        // cache under the fallback TARGET key ONLY when that target is a positively
        // identified declared literal ISR page rendering HTML (`isFallbackTargetCacheable`).
        // A non-fallback SSR render is unaffected. This makes all three ISR write sites
        // apply identical fallback policy: a rewrite to an undeclared dynamic target
        // (e.g. `/api/* → /graphql`) is served LIVE but never shared-cached, even when it
        // omits a Cache-Control opt-out. (Without this, such a write is unreadable —
        // keyed `<target>#rw=hash(<original non-ISR-eligible path>)`, which no later
        // request recomputes — but it is still a wasted KV write and a defense-in-depth
        // gap, so the gate is correct as both consistency and hardening.)
        if (
          isrTtl > 0 &&
          response.status === 200 &&
          routing.ssr &&
          !isApiPath(pathname) &&
          !hasExtension(pathname) &&
          (routing.type !== 'framework' || isHtmlResponse(response)) &&
          !hasSharedCacheOptOut(response) &&
          (!writebackFallbackApplied ||
            isFallbackTargetCacheable(routing.pages, pathname, response, routing.pathRevalidate))
        ) {
          const isrDeploymentId = routing.version ?? 'legacy';
          ctx.waitUntil(
            writeIsrCache(
              env,
              routing.projectId,
              isrDeploymentId,
              url.hostname,
              pathname,
              response,
              isrTtl,
              originalUrlVariant,
            ),
          );
          const jsonCacheKey = isrEdgeCacheKeyJson(
            request,
            pathname,
            isrDeploymentId,
            originalUrlVariant,
          );
          ctx.waitUntil(
            populateJsonEdgeCache(applicationEdgeCache, jsonCacheKey, response, isrTtl, 'HIT'),
          );
        }
      }

      // Strip internal header before returning to client
      if (response.headers.has('x-void-page-data')) {
        const stripped = new Response(response.body, response);
        stripped.headers.delete('x-void-page-data');
        return meter(
          applyHeaderRules(stripped, pathname, routing.headerRules),
          responseFailureKind,
        );
      }
      return meter(applyHeaderRules(response, pathname, routing.headerRules), responseFailureKind);
    } catch (err) {
      if (err instanceof DispatchTimeoutError) {
        if (err.label === 'static-asset') {
          return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_TIMEOUT);
        }
        // The dispatched request was still running when the budget ran out. It
        // counts as the app's when the worker, not the asset layer, owns the path.
        const dynamicType = classifyDynamicRequestType(
          pathname,
          routing.ssr,
          workerAnsweredPath(
            routing,
            pathname === staticCachePathname ? knownStaticAsset : undefined,
          ),
        );
        if (dynamicType) {
          requestType = dynamicType;
        }
        return meterWorkerTimeout();
      }
      if (err instanceof StaticAssetReadError) {
        return meterStaticAssetFailure(PLATFORM_STATIC_ASSET_ERROR);
      }
      if (err instanceof Error && err.message.includes('Worker exceeded')) {
        return meter(await limitResponse('execution'));
      }
      throw err;
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    if (
      env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain'
    ) {
      console.warn(
        `[queue-relay] platform traffic is staging; retrying queue="${batch.queue}" in ${PLATFORM_QUEUE_RETRY_DELAY_SECONDS}s`,
      );
      batch.retryAll({ delaySeconds: PLATFORM_QUEUE_RETRY_DELAY_SECONDS });
      return;
    }
    if (env.PLATFORM_INSTALLATION_ID) {
      let disabled: string | null;
      try {
        disabled = await env.ROUTING.get(PLATFORM_DISABLED_KEY);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[queue-relay] platform traffic gate read failed; retrying queue="${batch.queue}" in ${PLATFORM_QUEUE_RETRY_DELAY_SECONDS}s error=${JSON.stringify(message)}`,
        );
        batch.retryAll({ delaySeconds: PLATFORM_QUEUE_RETRY_DELAY_SECONDS });
        return;
      }
      if (disabled === PLATFORM_DISABLED_VALUE) {
        console.warn(
          `[queue-relay] platform traffic is disabled; retrying queue="${batch.queue}" in ${PLATFORM_QUEUE_RETRY_DELAY_SECONDS}s`,
        );
        batch.retryAll({ delaySeconds: PLATFORM_QUEUE_RETRY_DELAY_SECONDS });
        return;
      }
    }

    // Look up which user worker handles this queue
    const routingRaw = await env.ROUTING.get(`queue:${batch.queue}`, { cacheTtl: 60 });
    if (!routingRaw) {
      console.error(
        `[queue-relay] missing routing entry for queue="${batch.queue}"; retrying all messages`,
      );
      batch.retryAll();
      return;
    }
    const { workerName, projectId, queueName, proxyToken } = JSON.parse(
      routingRaw,
    ) as QueueRoutingEntry;
    if (projectId && (await isProjectSuspended(env, projectId))) {
      console.warn(
        `[queue-relay] project suspended; retrying queue="${batch.queue}" in ${SUSPENDED_PROJECT_QUEUE_RETRY_DELAY_SECONDS}s`,
      );
      batch.retryAll({ delaySeconds: SUSPENDED_PROJECT_QUEUE_RETRY_DELAY_SECONDS });
      return;
    }

    // Serialize batch for relay
    const messages = Array.from(batch.messages, (message) => ({
      id: message.id,
      timestamp: message.timestamp.toISOString(),
      body: message.body,
      attempts: message.attempts,
    }));

    const worker = env.DISPATCH.get(workerName);
    try {
      const body = JSON.stringify({ queue: queueName, messages });
      const queueHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (proxyToken) {
        queueHeaders['x-void-internal'] = proxyToken;
      }
      let res = await worker.fetch(
        new Request('https://internal/__void/queue', {
          method: 'POST',
          headers: queueHeaders,
          body,
        }),
      );
      // Legacy: fall back for workers deployed before the /__void/ migration.
      // TODO: remove once all deployed workers use /__void/* paths.
      if (res.status === 404) {
        res = await worker.fetch(
          new Request('https://internal/__queue', {
            method: 'POST',
            headers: queueHeaders,
            body,
          }),
        );
      }

      if (!res.ok) {
        // Preserve observability: dispatch tail ingests this under the
        // __platform-dispatch project key so operators can query who is
        // rejecting relays and why.
        let snippet = '';
        try {
          snippet = (await res.clone().text()).slice(0, 200);
        } catch {
          /* body may be unreadable — status alone is still useful */
        }
        console.error(
          `[queue-relay] relay failed queue="${queueName}" worker="${workerName}" status=${res.status} body=${JSON.stringify(snippet)}`,
        );
        // Never relayed again with another token: the Worker's own middleware
        // has already run for this request. A later delivery runs it again, as
        // any queue retry does.
        if (res.status === 401 || res.status === 403) {
          batch.retryAll({ delaySeconds: QUEUE_TOKEN_REJECTED_RETRY_DELAY_SECONDS });
        } else {
          batch.retryAll();
        }
        return;
      }

      let result: {
        ok?: boolean;
        decisions?: Record<string, { action: string; delaySeconds?: number }>;
      };
      try {
        result = await res.json();
      } catch {
        // Non-JSON 2xx = legacy framework, treat as success
        batch.ackAll();
        return;
      }

      if (!result.decisions) {
        // No decisions = legacy protocol, batch fallback
        if (result.ok !== false) {
          batch.ackAll();
        } else {
          batch.retryAll();
        }
        return;
      }

      // Apply per-message decisions
      const messageMap = new Map(batch.messages.map((message) => [message.id, message]));
      for (const [id, decision] of Object.entries(result.decisions)) {
        const cfMessage = messageMap.get(id);
        if (!cfMessage) {
          continue;
        }
        if (decision.action === 'ack') {
          cfMessage.ack();
        } else if (decision.action === 'retry') {
          cfMessage.retry(
            decision.delaySeconds != null ? { delaySeconds: decision.delaySeconds } : undefined,
          );
        }
      }

      // Undecided messages: if handler failed, retry all (individual decisions survive per CF)
      if (result.ok === false) {
        batch.retryAll();
      }
      // If ok=true, undecided messages get implicit ack (CF default on successful consumer return)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[queue-relay] relay threw queue="${queueName}" worker="${workerName}" error=${JSON.stringify(msg)}`,
      );
      batch.retryAll();
    }
  },
} satisfies ExportedHandler<Env>;

export default dispatcher;

/** Only the platform API is bound to this entrypoint; public HTTP uses dispatcher. */
export class PreviewDispatcher extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return dispatcher.fetch(request, this.env, this.ctx, true);
  }
}

class StaticAssetReadError extends Error {
  constructor(cause: unknown) {
    super('Static asset storage read failed', { cause });
    this.name = 'StaticAssetReadError';
  }
}

function logStaticAssetMissing(routing: RoutingEntry, pathname: string, hash: string): void {
  console.error(
    JSON.stringify({
      event: 'static-asset-missing',
      store: hash.startsWith('!') ? 'r2' : 'kv',
      projectId: routing.projectId,
      deploymentId: routing.staticDeploymentId ?? routing.assetManifestId,
      pathname,
      ts: Date.now(),
    }),
  );
}

/**
 * Fetch a static asset from KV (legacy small files) or R2 (`!`-prefixed modern
 * direct uploads and legacy large files).
 *
 * The complete scoped→legacy sequence gets one delayed hedge and one absolute
 * timeout. Hedging the sequence (rather than each binding result) means a KV
 * `{ value: null }` miss has the same semantics as an R2 `null` miss.
 *
 * Each sequence tries the project-scoped key first
 * (`assets/{projectId}/{hash}`), then the legacy shared key (`assets/{hash}`)
 * for backward compatibility with deployments created before asset key
 * scoping.
 * Returns null if the asset is not found.
 */
async function fetchStaticAsset(
  env: Env,
  hash: string,
  path: string,
  projectId?: string,
  deploymentId?: string,
  timeoutMs = 10000,
): Promise<Response | null> {
  const hedgeDelayMs = staticAssetHedgeDelayMs(timeoutMs);
  const startedAt = Date.now();
  let hedged = false;

  try {
    const result = await withDelayedHedge(() => fetchStaticAssetOnce(env, hash, path, projectId), {
      delayMs: hedgeDelayMs,
      timeoutMs,
      label: 'static-asset',
      discard: async (late) => {
        await late.body?.cancel();
      },
      onHedge: () => {
        hedged = true;
        console.warn(
          JSON.stringify({
            event: 'static-asset-read-hedge',
            store: hash.startsWith('!') ? 'r2' : 'kv',
            projectId,
            deploymentId,
            pathname: path,
            delayMs: hedgeDelayMs,
            ts: Date.now(),
          }),
        );
      },
    });

    if (hedged) {
      console.warn(
        JSON.stringify({
          event: 'static-asset-read-hedge-result',
          store: hash.startsWith('!') ? 'r2' : 'kv',
          projectId,
          deploymentId,
          pathname: path,
          outcome: result === null ? 'miss' : 'hit',
          elapsedMs: Date.now() - startedAt,
          ts: Date.now(),
        }),
      );
    }
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        event:
          error instanceof DispatchTimeoutError
            ? 'static-asset-timeout'
            : 'static-asset-read-error',
        store: hash.startsWith('!') ? 'r2' : 'kv',
        projectId,
        deploymentId,
        pathname: path,
        hedged,
        elapsedMs: Date.now() - startedAt,
        error:
          error instanceof DispatchTimeoutError
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
        ts: Date.now(),
      }),
    );
    if (error instanceof DispatchTimeoutError) {
      throw error;
    }
    throw new StaticAssetReadError(error);
  }
}

async function fetchStaticAssetOnce(
  env: Env,
  hash: string,
  path: string,
  projectId?: string,
): Promise<Response | null> {
  const isLarge = hash.startsWith('!');
  const cleanHash = isLarge ? hash.slice(1) : hash;
  const scopedKey = projectId ? `assets/${projectId}/${cleanHash}` : null;
  const legacyKey = `assets/${cleanHash}`;

  if (isLarge) {
    // Try scoped key first, then legacy
    const obj = scopedKey
      ? ((await env.STATIC_ASSETS_R2.get(scopedKey)) ?? (await env.STATIC_ASSETS_R2.get(legacyKey)))
      : await env.STATIC_ASSETS_R2.get(legacyKey);
    if (!obj) {
      return null;
    }
    const contentType = resolveAssetContentType(obj.httpMetadata?.contentType, path);
    const headers: HeadersInit = {
      ETag: obj.httpEtag,
      ...(obj.size ? { 'Content-Length': String(obj.size) } : {}),
    };
    if (contentType) {
      (headers as Record<string, string>)['Content-Type'] = contentType;
    }
    return new Response(obj.body, { headers });
  }

  const readKvAsset = async (key: string): Promise<Response | null> => {
    const { value, metadata } = await env.STATIC_ASSETS.getWithMetadata<{ ct: string }>(key, {
      type: 'arrayBuffer',
      cacheTtl: 86400,
    });
    if (!value) {
      return null;
    }
    const contentType = resolveAssetContentType(metadata?.ct, path);
    const headers: HeadersInit = {
      'Content-Length': String((value as ArrayBuffer).byteLength),
    };
    if (contentType) {
      (headers as Record<string, string>)['Content-Type'] = contentType;
    }
    return new Response(value, { headers });
  };

  // Try scoped key first, then legacy
  return (scopedKey ? await readKvAsset(scopedKey) : null) ?? readKvAsset(legacyKey);
}

/** Get a dispatch worker, applying custom limits if configured. */
function getWorker(env: Env, routing: RoutingEntry): Fetcher {
  if (routing.limits) {
    return env.DISPATCH.get(routing.workerName, {}, { limits: routing.limits });
  }
  return env.DISPATCH.get(routing.workerName);
}

/**
 * Revalidate an ISR page in the background.
 * Dispatches to the user worker (always as HTML, no X-VoidPages), writes HTML
 * to KV + HTML edge cache, and populates JSON edge cache from embedded page data.
 * Errors are caught and logged — serve stale, don't retry.
 */
async function revalidateInBackground(
  env: Env,
  routing: RoutingEntry,
  request: Request,
  host: string,
  pathname: string,
  defaultTtl: number,
  cacheKey: Request,
  jsonCacheKey: Request,
  staleSinceMs: number,
  originalUrl?: string | null,
  timeoutMs = 10000,
): Promise<boolean> {
  try {
    const worker = getWorker(env, routing);
    const revalidationStartedAt = Date.now();
    // Strip X-VoidPages so the worker always returns HTML.
    // Use rebuildRequest so request.cf (country/colo/botManagement/tlsClientAuth)
    // survives the rebuild — otherwise the background re-render runs with
    // cf === undefined and writes wrong-geo/wrong-bot HTML into the ISR cache.
    const cleanRequest = rebuildRequest(request, request.url, (headers) =>
      headers.delete('X-VoidPages'),
    );
    let response = await withTimeout(
      worker.fetch(cleanRequest),
      remainingTimeoutBudget(revalidationStartedAt, timeoutMs, 'dispatch'),
      'dispatch',
    );
    if (isEventStreamResponse(response)) {
      return false;
    }
    // Capture the ORIGIN page's OWN pre-fallback status. Only a genuine removal
    // signal (404/410 Gone) may later drive grace-eviction; a transient 5xx / 429 /
    // timeout must PRESERVE the stale entry (stale-while-revalidate). Read it here,
    // before `applyWorkerFallbackRules` reassigns `response` to a fallback target.
    const originalStatus = response.status;
    const fallbackResult = await applyWorkerFallbackRules({
      response,
      worker,
      dispatchReq: cleanRequest,
      routing,
      pathname,
      url: new URL(cleanRequest.url),
      originalRequestUrl: request.url,
      originalUrlHeader: request.headers.get('X-Void-Original-URL') ?? undefined,
      originalUrlVariant: originalUrl ?? undefined,
      deadline: { startedAt: revalidationStartedAt, timeoutMs },
    });
    response = fallbackResult.response;
    if (isEventStreamResponse(response)) {
      return false;
    }
    const assetFallbackResult = await maybeServeWfpAssetFallback({
      env,
      routing,
      pathname: fallbackResult.pathname,
      response,
      userAgent: request.headers.get('user-agent'),
      deadline: { startedAt: revalidationStartedAt, timeoutMs },
    });
    response = assetFallbackResult.response;
    if (isEventStreamResponse(response)) {
      return false;
    }
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    const cache = applicationEdgeCache;
    // Evict every shared representation of this entry: KV + HTML edge + JSON edge.
    const evictSharedEntry = async () => {
      await deleteIsrCache(
        env,
        routing.projectId,
        routing.version ?? 'legacy',
        host,
        pathname,
        originalUrl,
      );
      await cache.delete(cacheKey);
      await cache.delete(jsonCacheKey);
    };
    // The pathname this background re-render effectively resolved to. A fallback
    // rewrite (page 404 → 200 from `/api/*`) must not overwrite the page's ISR
    // entry with a dynamic API body — same guard as the miss-write.
    const effectiveBgPathname = fallbackResult.applied ? fallbackResult.pathname : pathname;
    // Only a full 200 may refresh the shared cache — a background re-render that
    // returns 206/etc. (`.ok` is 200–299) must not overwrite the good entry.
    // A re-render that falls back to `/api/*` must not overwrite the page's entry
    // with a dynamic API body. And — the shared-cache-safety gate mirrored from the
    // miss-write — when a FALLBACK was APPLIED the re-render may refresh the ORIGINAL
    // page key ONLY when its TARGET is the winning EXACT declared literal ISR page
    // and the render is HTML; any other target (a dotted shell, an undeclared
    // extensionless `/graphql`) is not shared-cached and must not overwrite the entry.
    if (
      ttl > 0 &&
      response.status === 200 &&
      (routing.type !== 'framework' || isHtmlResponse(response)) &&
      !isApiPath(effectiveBgPathname) &&
      !hasSharedCacheOptOut(response) &&
      (!fallbackResult.applied ||
        isFallbackTargetCacheable(
          routing.pages,
          effectiveBgPathname,
          response,
          routing.pathRevalidate,
        ))
    ) {
      await writeIsrCache(
        env,
        routing.projectId,
        routing.version ?? 'legacy',
        host,
        pathname,
        response,
        ttl,
        originalUrl,
      );
      // Update HTML edge cache with fresh response
      const headers = new Headers(response.headers);
      headers.set('x-isr-cache', 'HIT');
      headers.set('Cache-Control', `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
      markSharedCachePolicy(headers);
      headers.delete('set-cookie');
      headers.delete('x-void-page-data');
      await cache.put(
        cacheKey,
        new Response(response.clone().body, {
          status: response.status,
          headers,
        }),
      );
      await populateJsonEdgeCache(cache, jsonCacheKey, response, ttl, 'HIT');
      return true;
    } else if (
      response.status === 200 &&
      !isApiPath(effectiveBgPathname) &&
      !fallbackResult.applied &&
      (ttl === 0 ||
        hasSharedCacheOptOut(response) ||
        (routing.type === 'framework' && !isHtmlResponse(response)))
    ) {
      // Evict the stale shared entry ONLY on an AUTHORITATIVE opt-out render of the
      // ORIGIN page itself: a successful render (200, NOT an `/api/*` fallback, and
      // NOT ANY applied fallback) that has withdrawn its public representation —
      // either a permanent `x-revalidate: 0` opt-out OR a `Cache-Control` opt-out
      // (private/no-store/no-cache). A FALLBACK firing means the ORIGIN page 404'd
      // (often transiently — deploy race); the fallback TARGET's cache intent must
      // NOT delete the origin page's last-known-good entry, so `!fallbackResult.applied`
      // gates eviction to an authoritative render of the origin page. A transient
      // non-200 (even one carrying `x-revalidate: 0`) likewise must NOT evict — keep
      // serving the last known-good entry (stale-while-revalidate resilience). The
      // write gate already refuses to cache non-authoritative content, so eviction
      // must mirror it. Removes KV + HTML + JSON edge.
      try {
        await evictSharedEntry();
      } catch (error) {
        console.error('ISR privacy eviction failed:', error);
      }
      return true;
    } else if (
      (originalStatus === 404 || originalStatus === 410) &&
      Date.now() - staleSinceMs > ISR_STALE_EVICT_GRACE_SECONDS * 1000
    ) {
      // Convergence — ONLY on positive removal evidence: the ORIGIN page's OWN
      // pre-fallback render returned 404 or 410 (gone). Such a re-render could neither
      // refresh this entry nor trigger the authoritative opt-out eviction above (a
      // permanent origin 404 that falls back to a non-declared shell — the write gate
      // refuses to cache it). It has now been STALE (since `createdAt + ttl`) beyond the bounded
      // grace — far past any transient deploy-race 404 — so the page is permanently
      // removed: evict it rather than serve its last cached body forever. A 5xx / 429 /
      // timeout / any other status is a DEGRADED DEPENDENCY, not a removal — it MUST
      // keep serving stale (stale-while-revalidate is exactly what protects that
      // request), so it never reaches this branch. Measuring from stale-onset (not
      // creation) means a long-TTL entry still gets the full grace and a transient
      // failure right after expiry keeps serving stale within the grace.
      try {
        await evictSharedEntry();
      } catch (error) {
        console.error('ISR stale-entry eviction failed:', error);
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('ISR revalidation failed:', err);
    return false;
  }
}

// ISR eligibility for a REQUEST's own pathname: SSR page paths only — never an
// `/api` route. A dotted path is ISR-eligible only when it matches a declared
// page route that is NOT a broad catch-all — a literal (`/feed.xml`) or a
// single-segment param (`/blog/:slug`, so `/blog/release.v2` gets ISR). A broad
// catch-all (`/:path{.+}`, `*`) that merely happens to match a static asset like
// `/robots.txt` does NOT make it page-ISR content. This is the read-gate
// predicate; it deliberately does NOT gate the fallback WRITE sites, which key
// off the fallback TARGET (see `isFallbackTargetCacheable`).
function isIsrEligiblePath(
  pathname: string,
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  revalidate: number | Record<string, number> | undefined,
  pathRevalidate: Record<string, number> | undefined,
): boolean {
  if (isApiPath(pathname)) {
    return false;
  }
  if (!hasExtension(pathname)) {
    return true;
  }
  return isDottedPathIsrEligible(pages, revalidate, pathRevalidate, pathname);
}

// A fallback render may enter the shared ORIGINAL page key ONLY when the target is
// the WINNING EXACT declared literal ISR page AND the render is HTML. There is no
// safe path-shape signal for a "static shell": a dotted `text/html` target
// (`/account.html`) is indistinguishable here from a dynamic per-user endpoint, so
// path shape is NOT trusted. A static SPA shell reached via fallback is still
// SERVED live; it is simply no longer opportunistically ISR-cached under a page key
// (its cache home is the static-asset path). Full metadata-verified shell caching
// would need an async asset-manifest lookup this write path does not have.
function isFallbackTargetCacheable(
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  targetPathname: string,
  response: Response,
  pathRevalidate: Record<string, number> | undefined,
): boolean {
  return isHtmlResponse(response) && matchesLiteralPage(pages, targetPathname, pathRevalidate);
}

/**
 * Every static cache shares one representation across callers, so credentials,
 * EventSource semantics, partial requests, and Pages-protocol requests bypass it.
 */
function isSharedStaticCacheRequestEligible(request: Request): boolean {
  return Boolean(
    request.method === 'GET' &&
    !request.headers.has('Range') &&
    !request.headers.has('X-VoidPages') &&
    !shouldBypassIsr(request),
  );
}

/** Shared request-side eligibility for the deploy-versioned static cache. */
function isStaticCacheRequestEligible(
  request: Request,
  pathname: string,
  routing: RoutingEntry,
): boolean {
  return Boolean(
    isSharedStaticCacheRequestEligible(request) &&
    routing.version &&
    !isApiPath(pathname) &&
    (hasExtension(pathname) || !routing.ssr),
  );
}

/**
 * Whether `pathname` may use the deploy-versioned static cache.
 *
 * - `true`: a static deploy, a non-SSR deploy, or a path the SSR deploy's asset
 *   manifest lists.
 * - `false`: the SSR deploy's asset manifest was read, does not list the path,
 *   and lists no HTML file Cloudflare's `html_handling` would answer it from.
 * - `undefined`: there is no manifest to consult, it could not be read, or
 *   `html_handling` would answer the path from a listed HTML file.
 *
 * Only `true` makes a request a static-cache candidate.
 */
async function isKnownStaticAssetPath(
  env: Env,
  pathname: string,
  routing: RoutingEntry,
  timeoutMs: number,
): Promise<boolean | undefined> {
  if (routing.staticDeploymentId) {
    return true;
  }
  if (!routing.ssr) {
    return true;
  }
  if (!routing.assetManifestId) {
    return undefined;
  }
  try {
    const manifest = await fetchAssetManifest(
      env,
      routing.assetManifestId,
      routing.projectId,
      Math.min(timeoutMs, STATIC_ASSET_HEDGE_DELAY_MS),
    );
    if (!manifest) {
      return undefined;
    }
    if (Object.hasOwn(manifest, pathname)) {
      return true;
    }
    const decoded = safeDecodePathname(pathname);
    if (decoded !== pathname && Object.hasOwn(manifest, decoded)) {
      return true;
    }
    // Not a listed file, but Cloudflare's asset layer may still serve or
    // redirect it from an HTML file, so it is not known to be the worker's.
    const htmlHandling = routing.assetConfig?.html_handling ?? 'auto-trailing-slash';
    if (
      htmlHandling !== 'none' &&
      (hasHtmlHandlingSource(manifest, pathname) || hasHtmlHandlingSource(manifest, decoded))
    ) {
      return undefined;
    }
    return false;
  } catch {
    // Asset identity is an optimization gate. If the manifest is unavailable,
    // dispatch the request live instead of guessing from the URL or response.
    return undefined;
  }
}

/**
 * Whether the manifest lists an HTML file that Cloudflare's `html_handling`
 * serves or redirects to for `pathname`: `/x` from `/x.html` or
 * `/x/index.html`, `/x.html` from `/x/index.html`, and `/x/index.html` from
 * `/x.html`. Every mode except `none` reads these same files.
 */
function hasHtmlHandlingSource(manifest: Record<string, string>, pathname: string): boolean {
  const sources = [`${pathname}.html`, `${pathname}/index.html`];
  if (pathname.endsWith('.html')) {
    const base = pathname.slice(0, -'.html'.length);
    sources.push(`${base}/index.html`);
    if (base.endsWith('/index')) {
      sources.push(`${base.slice(0, -'/index'.length)}.html`);
    }
  }
  return sources.some((source) => Object.hasOwn(manifest, source));
}

/**
 * Whether the user worker, not Cloudflare's asset layer, answers `pathname`.
 * `listed` is the asset manifest's answer for the path (see
 * `isKnownStaticAssetPath`).
 *
 * A worker deploy published since asset manifests were introduced has no
 * manifest only when it uploaded no files, so the worker answers everything.
 * So does a deploy whose `run_worker_first` covers every path. Older live
 * deploys may still have an asset layer without a manifest, so callers use a
 * `true` here for a successful response only when the manifest also marks the
 * path unlisted. Otherwise the asset layer serves listed files itself, and an
 * unlisted path reaches the worker only with `not_found_handling: 'none'`
 * (Cloudflare's default); the SPA shell and the 404 page come from the asset
 * layer. When `listed` is `undefined` (no readable manifest, or an HTML file the
 * asset layer answers the path from), the path is not known to be the worker's.
 */
function workerAnsweredPath(routing: RoutingEntry, listed: boolean | undefined): boolean {
  if (!routing.assetManifestId) {
    return true;
  }
  const runWorkerFirst = routing.assetConfig?.run_worker_first;
  if (
    runWorkerFirst === true ||
    (Array.isArray(runWorkerFirst) && runWorkerFirst.includes('/**'))
  ) {
    return true;
  }
  return listed === false && (routing.assetConfig?.not_found_handling ?? 'none') === 'none';
}

/** Apply the same origin/cached response policy to static reads and writes. */
function isStaticCacheResponseEligible(response: Response): boolean {
  return (
    response.status === 200 && !isEventStreamResponse(response) && !hasSharedCacheOptOut(response)
  );
}

/** Only entries written under the current shared-cache policy are safe to serve. */
function isCurrentStaticCacheResponse(response: Response): boolean {
  return hasCurrentSharedCachePolicy(response) && isStaticCacheResponseEligible(response);
}

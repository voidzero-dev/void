import { redirectToHttps } from '@void/edge';
import type { ExecutionContext } from 'hono';
import { createManifestLoader, type ManifestLoader } from './routing-assets.ts';

export type AssetBinding = { fetch: (request: Request) => Promise<Response> };
export type RuntimeEnvironment = Record<string, unknown> & { ASSETS?: AssetBinding };
export type AssetFallbackOptions = {
  assetsDir?: string;
  serveSpaFallback?: boolean;
  notFound?: 'none' | '404-page' | 'single-page-application';
};
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Apply native static policy before application middleware adds authored headers. */
export function applyAssetCachePolicy(
  request: Request,
  asset: Response,
  assetsDir = 'assets',
  fingerprinted = false,
): Response {
  if (!['GET', 'HEAD'].includes(request.method) || ![200, 206, 304].includes(asset.status)) {
    return asset;
  }
  const pathname = new URL(request.url).pathname;
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const headers = new Headers(asset.headers);
  if (!headers.has('Content-Type') && ASSET_CONTENT_TYPES[extension]) {
    headers.set('Content-Type', ASSET_CONTENT_TYPES[extension]);
  }
  const policy = headers.get('Cache-Control');
  const directives = (policy ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .sort();
  const providerDefault = directives.join(',') === 'max-age=0,must-revalidate,public';
  const hashed =
    fingerprinted &&
    pathname.startsWith('/' + assetsDir.replace(/^\/+|\/+$/g, '') + '/') &&
    extension !== '.html' &&
    !(headers.get('Content-Type') ?? '').toLowerCase().includes('text/html');
  if (!headers.has('Set-Cookie') && hashed && (!policy || providerDefault)) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (!policy) {
    headers.set('Cache-Control', 'no-store');
  }
  // Cache API and fetch responses can have immutable headers. Preserve the
  // original response and change only this application-owned wrapper.
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

/** Public filenames are never evidence of a content fingerprint. */
export function createAssetCachePolicy(
  assetsDir?: string,
  loadManifest: ManifestLoader = createManifestLoader(),
): (request: Request, env: RuntimeEnvironment, asset: Response) => Promise<Response> {
  let files: Promise<Set<string>> | undefined;
  return async (request, env, asset) => {
    const path = new URL(request.url).pathname;
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      ![200, 206, 304].includes(asset.status) ||
      !path.startsWith('/' + (assetsDir ?? 'assets').replace(/^\/+|\/+$/g, '') + '/')
    ) {
      return applyAssetCachePolicy(request, asset, assetsDir);
    }
    if (!files) {
      // Optional cache metadata must not make a successfully served asset fail.
      files = loadManifest(request, env).then(
        (manifest) =>
          new Set(
            Object.values(manifest ?? {}).flatMap((entry) =>
              Array.isArray(entry?.immutableFiles) ? entry.immutableFiles : [],
            ),
          ),
        () => new Set(),
      );
    }
    return applyAssetCachePolicy(request, asset, assetsDir, (await files).has(path.slice(1)));
  };
}

export function createAssetFallback(
  options: AssetFallbackOptions = {},
): (request: Request, env: RuntimeEnvironment, response: Response) => Promise<Response> {
  const cachePolicy = createAssetCachePolicy(options.assetsDir);
  return async (request, env, response) => {
    if (
      response.status !== 404 ||
      !env.ASSETS ||
      (request.method !== 'GET' && request.method !== 'HEAD')
    ) {
      return response;
    }
    const asset = await env.ASSETS.fetch(
      new Request(request.url, { method: request.method, headers: request.headers }),
    );
    if (asset.status !== 404) {
      return cachePolicy(request, env, asset);
    }
    const accept = request.headers.get('accept') ?? '';
    if (options.serveSpaFallback && accept.includes('text/html')) {
      const url = new URL('/index.html', request.url);
      const index = await env.ASSETS.fetch(new Request(url, { method: request.method }));
      if (index.status === 200) {
        const res = new Response(index.body, { status: 200, headers: index.headers });
        res.headers.set('Cache-Control', 'no-store');
        res.headers.set('Content-Type', 'text/html; charset=utf-8');
        return res;
      }
    } else if (
      !options.serveSpaFallback &&
      options.notFound === '404-page' &&
      accept.includes('text/html') &&
      (asset.headers.get('content-type') ?? '').includes('text/html')
    ) {
      const res = new Response(asset.body, asset);
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    return response;
  };
}

/** Hide platform capabilities without copying bindings or changing application bindings. */
export function filterInternalBindings<E extends Record<string, unknown>>(
  env: E,
  prefixes: Array<string>,
  exactNames: Array<string> = [],
): E {
  const hidden = (key: string | symbol): boolean =>
    typeof key === 'string' &&
    (prefixes.some((prefix) => key.startsWith(prefix)) || exactNames.includes(key));
  return new Proxy(env, {
    get: (target, prop, receiver) =>
      hidden(prop) ? undefined : Reflect.get(target, prop, receiver),
    has: (target, prop) => !hidden(prop) && Reflect.has(target, prop),
    ownKeys: (target) => Reflect.ownKeys(target).filter((key) => !hidden(key)),
    getOwnPropertyDescriptor: (target, prop) =>
      hidden(prop) ? undefined : Reflect.getOwnPropertyDescriptor(target, prop),
  });
}

export type WorkerFetchOptions = {
  app: {
    fetch: (
      request: Request,
      env: RuntimeEnvironment,
      context: ExecutionContext,
    ) => Response | Promise<Response>;
  };
  assets: ReturnType<typeof createAssetFallback>;
  withRawEnv: (env: RuntimeEnvironment, fn: () => Promise<Response>) => Promise<Response>;
  withRuntimeEnv: (env: RuntimeEnvironment, fn: () => Promise<Response>) => Promise<Response>;
  filterBindings: (env: RuntimeEnvironment) => RuntimeEnvironment;
  validateEnv?: (env: RuntimeEnvironment) => Promise<void>;
  /** Native Cloudflare production builds redirect public HTTP requests to HTTPS. */
  alwaysUseHttps?: boolean;
  /** Authored/generated version metadata binding used to prove the served native version. */
  versionMetadataBinding?: string;
  remoteEnv?: (env: RuntimeEnvironment) => RuntimeEnvironment;
  internalRoute: (
    request: Request,
    env: RuntimeEnvironment,
    ctx: ExecutionContext,
  ) => Promise<Response | null>;
  collectPrerenderPaths: (
    request: Request,
    env: RuntimeEnvironment,
    ctx: ExecutionContext,
  ) => Promise<Array<string>>;
  emailReceipt?: (
    request: Request,
    env: RuntimeEnvironment,
    ctx: ExecutionContext,
  ) => Promise<Response>;
  isr?: {
    deploymentId: string;
    handle: (
      request: Request,
      env: RuntimeEnvironment,
      ctx: ExecutionContext,
      render: (request: Request) => Promise<Response>,
    ) => Promise<Response | null>;
  };
};
export function createWorkerFetch(
  options: WorkerFetchOptions,
): (request: Request, env: RuntimeEnvironment, ctx: ExecutionContext) => Promise<Response> {
  return async (request, originalEnv, ctx) => {
    const url = new URL(request.url);
    // Only the build-time prerender runner sets this binding. Without it the
    // request is an ordinary app request, so env validation runs as usual.
    const discovery =
      request.method === 'POST' &&
      url.pathname === '/__void/prerender-paths' &&
      originalEnv.__VOID_PRERENDER === '1';
    if (options.validateEnv && !discovery) {
      await options.validateEnv(originalEnv);
    }
    const env =
      options.remoteEnv && originalEnv.__VOID_REMOTE === '1'
        ? options.remoteEnv(originalEnv)
        : originalEnv;
    if (options.isr) {
      env.__VOID_ISR_DEPLOYMENT_ID ??= options.isr.deploymentId;
      env.__VOID_ISR_HOST = url.hostname;
    }
    return options.withRawEnv(env, () =>
      options.withRuntimeEnv(env, async () => {
        if (options.emailReceipt && url.pathname === '/__void/email/receipt/v1') {
          return options.emailReceipt(request, env, ctx);
        }
        if (request.method === 'GET' && url.pathname === '/__void/ready') {
          const metadata = options.versionMetadataBinding
            ? (env[options.versionMetadataBinding] as { id?: unknown } | undefined)
            : undefined;
          return Response.json(
            { ready: true, ...(options.versionMetadataBinding ? { versionId: metadata?.id } : {}) },
            options.versionMetadataBinding
              ? { headers: { 'cache-control': 'no-store' } }
              : undefined,
          );
        }
        const internal = await options.internalRoute(request, env, ctx);
        if (internal) {
          return internal;
        }
        if (discovery) {
          return Response.json({ paths: await options.collectPrerenderPaths(request, env, ctx) });
        }
        // After the Void endpoints that tools and the platform call above, and
        // before ISR, so a cached page is never served over HTTP. The
        // build-time prerender runner fetches localhost, which is never redirected.
        if (options.alwaysUseHttps) {
          const redirect = redirectToHttps(request);
          if (redirect) {
            return redirect;
          }
        }
        const userEnv = options.filterBindings(env);
        const render = async (req: Request): Promise<Response> =>
          options.assets(req, env, await options.app.fetch(req, userEnv, ctx));
        if (
          options.isr &&
          env.ISR_CACHE &&
          request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
        ) {
          const cached = await options.isr.handle(request, env, ctx, render);
          if (cached) {
            return cached;
          }
        }
        return render(request);
      }),
    );
  };
}

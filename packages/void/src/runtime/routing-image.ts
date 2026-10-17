import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ExecutionContext } from 'hono';
import type { ResolvedImageConfig } from '../image/config.ts';
import {
  handleImageRequest,
  type ImageCacheLike,
  type ImagesBindingLike,
} from '../image/optimizer/handler.ts';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw.ts';
import { createManifestLoader, type ManifestLoader } from './routing-assets.ts';
import type { RuntimeEnvironment } from './routing-worker.ts';

export type ImageHandlerOptions = {
  /** The resolved `images` configuration, baked into the generated route table. */
  config: ResolvedImageConfig;
  /** Compile-time deployment id (the route table's `__VOID_ISR_DEPLOYMENT_ID` literal). */
  deploymentId: string;
  /** Vite `build.assetsDir`. Only files below it can be fingerprinted build assets. */
  assetsDir?: string;
  /**
   * Fingerprinted client files (no leading `/`). Defaults to every
   * `immutableFiles` entry of the client manifest the asset cache policy reads.
   */
  immutableFiles?: Iterable<string>;
  /** Client manifest loader; tests replace it. */
  loadManifest?: ManifestLoader;
};

/** The generated Hono app, which local source requests run through. */
export type ImageSourceApp = {
  fetch: (
    request: Request,
    env: RuntimeEnvironment,
    context?: ExecutionContext,
  ) => Response | Promise<Response>;
};

const DEFAULT_IMAGES_BINDING = 'IMAGES';
const RECURSIVE = '"url" parameter cannot be recursive';

/**
 * Set while a local source request runs through the app. A rewrite of that
 * request back to the endpoint answers `400` instead of recursing.
 */
const loadingSource = new AsyncLocalStorage<true>();

function rawEnv(): RuntimeEnv | undefined {
  try {
    return getRawRuntimeEnv();
  } catch {
    // Node targets run without a request env scope.
    return undefined;
  }
}

/** `caches.default`, when this runtime has the Workers Cache API. */
function defaultCache(): ImageCacheLike | undefined {
  try {
    // The DOM lib that the pages client modules reference declares
    // CacheStorage without `.default`, shadowing the Workers type here.
    const cache =
      typeof caches === 'undefined'
        ? undefined
        : (caches as unknown as { default?: ImageCacheLike }).default;
    return cache && typeof cache.match === 'function' && typeof cache.put === 'function'
      ? cache
      : undefined;
  } catch {
    return undefined;
  }
}

function executionContext(c: Context): ExecutionContext | undefined {
  try {
    // Hono throws when the runtime passed no execution context (Node targets).
    const ctx = c.executionCtx as { waitUntil?: unknown } | undefined;
    return ctx && typeof ctx.waitUntil === 'function' ? (ctx as ExecutionContext) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `/_void/image` route handler. Generated route tables mount it only when
 * the app uses `Image` with the default loader. The Images binding is
 * `env.IMAGES`, or the custom name the build stamps into
 * `__VOID_IMAGES_BINDING`; without a binding, images are served unchanged.
 * Development skips the response cache and fingerprint lookups.
 *
 * With `app`, a local source is requested from the app with no headers, as
 * the Worker would serve it to a client without cookies: path-scoped
 * middleware applies to it (as Next.js runs `/_next/image` sources through
 * its router), and an app `404` falls back to `env.ASSETS`. Without `app`,
 * local sources are read from `env.ASSETS` directly.
 */
export function createImageHandler(
  options: ImageHandlerOptions,
  app?: ImageSourceApp,
): (c: Context) => Promise<Response> {
  const { config } = options;
  const assetsPrefix = '/' + (options.assetsDir ?? 'assets').replace(/^\/+|\/+$/g, '') + '/';
  const loadManifest = options.loadManifest ?? createManifestLoader();
  let immutableFiles: Promise<Set<string>> | undefined = options.immutableFiles
    ? Promise.resolve(new Set(options.immutableFiles))
    : undefined;
  return async (c) => {
    if (loadingSource.getStore()) {
      return new Response(RECURSIVE, { status: 400 });
    }
    const env = (c.env ?? {}) as RuntimeEnvironment;
    const raw = rawEnv();
    const bindingName =
      typeof raw?.__VOID_IMAGES_BINDING === 'string'
        ? raw.__VOID_IMAGES_BINDING
        : DEFAULT_IMAGES_BINDING;
    const binding = (env[bindingName] ?? raw?.[bindingName]) as
      | Partial<ImagesBindingLike>
      | undefined;
    const ctx = executionContext(c);
    const request = c.req.raw;
    return handleImageRequest(request, {
      config,
      deploymentId: options.deploymentId,
      assets: env.ASSETS,
      binding:
        binding && typeof binding.input === 'function' ? (binding as ImagesBindingLike) : undefined,
      bindingName,
      fetchLocal: app
        ? (source) =>
            loadingSource.run(true, async () =>
              ctx ? app.fetch(source, env, ctx) : app.fetch(source, env),
            )
        : undefined,
      cache: config.dev ? undefined : defaultCache(),
      waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
      isImmutable: config.dev
        ? undefined
        : async (pathname) => {
            if (!pathname.startsWith(assetsPrefix)) {
              return false;
            }
            // Same proof as the static asset cache policy: optional metadata
            // that fails to load only means no image is treated as immutable.
            immutableFiles ??= loadManifest(request, env).then(
              (manifest) =>
                new Set(
                  Object.values(manifest ?? {}).flatMap((entry) =>
                    Array.isArray(entry?.immutableFiles) ? entry.immutableFiles : [],
                  ),
                ),
              () => new Set(),
            );
            const files = await immutableFiles;
            const path = pathname.slice(1);
            if (files.has(path)) {
              return true;
            }
            try {
              return files.has(decodeURIComponent(path));
            } catch {
              return false;
            }
          },
    });
  };
}

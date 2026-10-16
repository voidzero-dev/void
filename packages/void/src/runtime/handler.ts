import type { Context, Env, MiddlewareHandler } from 'hono';
import type { RewriteDestination } from 'void/routes';
import type { HeadDescriptor } from '../pages/head.ts';
import type { AuthSession, AuthUser } from './auth.ts';
import { base64ToBytes } from './base64.ts';
import { convertReturnValue } from './response.ts';
import { runValidation, type ValidatorSlots, type HandlerInput } from './validator.ts';

/**
 * Thrown when `c.rewrite()` is called with a destination whose final path
 * segment ends in a known static-asset extension (e.g. `/hero.png`,
 * `/app.css`). Runtime rewrites only reach routes and SSR entries inside
 * the worker — static asset handlers run in front of the worker, so a
 * `c.rewrite()` into an asset path re-enters the Hono router, matches
 * nothing, and returns a 404. Fail at the call site so users reach for
 * static `routing.rewrites` instead of debugging a mystery 404.
 */
export class VoidAssetRewriteError extends Error {
  override name = 'VoidAssetRewriteError';
  constructor(destination: string) {
    super(
      `c.rewrite() cannot re-dispatch to a static asset path (${JSON.stringify(destination)}). Runtime rewrites only reach routes and SSR entries inside the worker — static asset handlers run in front of the worker. To rewrite into an asset, use a static \`routing.rewrites\` rule in void.json or a \`200!\` entry in _redirects. See https://void.dev/guide/edge/rewrites#runtime-rewrites-cannot-reach-static-assets`,
    );
  }
}

/** Hono `Variables` for Void workers, including auth values populated by Better Auth middleware. */
export interface CloudContextVariables {
  user: AuthUser | null;
  session: AuthSession | null;
  headDefaults?: HeadDescriptor;
  [key: string]: unknown;
}

// Generated env types augment this stable global interface. Public module
// augmentation alone cannot reach CloudBindings after declaration bundling
// moves its source interface into a shared declaration chunk.
declare global {
  interface VoidGeneratedEnvBindings {
    readonly [key: string]: unknown;
  }
}

/**
 * Hono `Bindings` shape for Void workers.
 *
 * Augmented by the generated `.void/env.d.ts` so user-declared env keys
 * become typed on `c.env`. The index signature keeps untyped access
 * working for bindings that aren't in the schema (queues, custom
 * bindings, etc.).
 */
export interface CloudBindings extends VoidGeneratedEnvBindings {
  DB: D1Database;
  KV: KVNamespace;
  STORAGE: R2Bucket;
  AI: Ai;
  IMAGES: ImagesBinding;
  SANDBOX: DurableObjectNamespace<import('./sandbox.ts').VoidPlatformSandbox>;
  [key: string]: unknown;
}

export type CloudEnv = Env & {
  Bindings: CloudBindings;
  Variables: CloudContextVariables;
};

declare module 'hono' {
  interface Context {
    /**
     * Rewrite the request to a different internal path without changing the browser URL.
     *
     * Must be called inside a `defineMiddleware` handler and the result must be returned:
     *
     * ```ts
     * export default defineMiddleware(async (c, next) => {
     *   if (!hasLocalePrefix(c.req.path)) {
     *     return c.rewrite(`/en${c.req.path}`);
     *   }
     *   return next();
     * });
     * ```
     *
     * The request is re-dispatched through the Hono router with the new pathname.
     * The re-dispatched request is tracked internally so that static routing rules
     * do not re-evaluate on it. Your middleware is responsible for its own loop
     * prevention (e.g., checking if the path already has a prefix).
     *
     * The `path` type is `RewriteDestination`, which is `keyof RouteMap | (string & {})`.
     * Known routes autocomplete, but any string is still accepted so dynamic paths
     * (e.g. `` `/users/${id}` ``) continue to work. When `.void/routes.d.ts` has not
     * been generated yet, `RouteMap` is empty and this is equivalent to `string`.
     */
    rewrite: (path: RewriteDestination) => Promise<Response>;

    /**
     * Returns the URL the client actually requested — the pre-rewrite URL as
     * a `URL` object — or `null` when the current request was not rewritten.
     *
     * Set on every Void-managed request, whether the rewrite came from a
     * static rule (`routing.rewrites`, `routing.fallbacks`, `_redirects`
     * `200`/`200!`) or `c.rewrite()` in middleware. Useful for canonical
     * link generation and locale negotiation that must reference the URL
     * the user actually requested.
     */
    originalUrl: () => URL | null;

    /**
     * Returns `true` when the current request was re-dispatched by a rewrite,
     * `false` otherwise. Equivalent to `c.originalUrl() !== null`.
     *
     * Use this to skip side-effectful work that would otherwise double-fire
     * on the second pass of middleware (request logging, rate-limit
     * increments, auth audit trails). Static rewrites (edge dispatch,
     * `routing.rewrites`, `routing.fallbacks`, `_redirects` `200`/`200!`)
     * and `c.rewrite()` in middleware both set the flag.
     */
    isRewritten: () => boolean;
  }
}

/**
 * Hono {@link Context} pre-typed with {@link CloudEnv}.
 *
 * This is the type of the `c` parameter in route handlers and middleware
 * created with {@link defineHandler} and {@link defineMiddleware}.
 */
export type CloudContext = Context<CloudEnv>;

type HandlerFn = (c: CloudContext) => unknown | Promise<unknown>;
type MiddlewareFn = MiddlewareHandler<CloudEnv>;
type BasicAuthOptionValue = string | (() => string);

export interface BasicAuthOptions {
  /** Username required by the Basic auth challenge. */
  username: BasicAuthOptionValue;
  /** Password required by the Basic auth challenge. */
  password: BasicAuthOptionValue;
  /** Browser prompt realm. Defaults to "Restricted". */
  realm?: BasicAuthOptionValue;
  /** Response body for failed authentication. Defaults to "Authentication required". */
  message?: BasicAuthOptionValue;
}

/** Pre-rendered asset tags injected by the SSR build. */
export type RenderAssetTags = {
  /** CSS stylesheet links for `<head>`. */
  css: string;
  /** JS modulepreload links for `<head>` (only when page needs JS). */
  preloads: string;
  /** Script tags for `</body>` (only when page needs JS). */
  body: string;
};
type RenderFn = (c: CloudContext, assetTags: RenderAssetTags) => Response | Promise<Response>;
type ScheduledFn = (
  controller: ScheduledController,
  env: CloudEnv['Bindings'],
  ctx: ExecutionContext,
) => unknown | Promise<unknown>;

export type QueueRetryOptions = { delaySeconds?: number };

/** A single message in a queue batch. */
export type QueueMessage<T = unknown> = {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
};

/** A batch of queue messages delivered to a consumer handler. */
export type QueueBatch<T = unknown> = {
  readonly queue: string;
  readonly messages: Array<QueueMessage<T>>;
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
};

type QueueFn<T = unknown> = (
  batch: QueueBatch<T>,
  env: CloudEnv['Bindings'],
) => void | Promise<void>;

/**
 * A typed queue handler with a phantom type carrier for the payload type.
 * `__payload` exists at the type level only —
 * TypeScript's `typeof import(...)` reads it for codegen.
 */
export type TypedQueueHandler<T = unknown> = {
  (batch: QueueBatch<T>, env: CloudEnv['Bindings']): void | Promise<void>;
  readonly __payload: T;
};

/**
 * A typed handler with phantom type carriers for validators and return type.
 * `__validators` and `__output` exist at the type level only —
 * TypeScript's `typeof import(...)` reads them for codegen.
 */
export type TypedHandler<V extends ValidatorSlots = {}, R = unknown> = {
  (c: CloudContext): Promise<Response> | Response | unknown | Promise<unknown>;
  readonly __validators: V;
  readonly __output: R;
};

/**
 * Define a route handler, optionally composed with per-route middleware.
 *
 * Single argument: identity wrapper.
 * Multiple arguments: middleware chain + final handler, composed at runtime.
 */
export function defineHandler<R>(
  handler: (c: CloudContext) => R | Response | Promise<R | Response>,
): TypedHandler<{}, Exclude<Awaited<R>, Response>>;
export function defineHandler(firstMiddleware: MiddlewareFn, handler: HandlerFn): TypedHandler;
export function defineHandler(
  firstMiddleware: MiddlewareFn,
  secondMiddleware: MiddlewareFn,
  handler: HandlerFn,
): TypedHandler;
export function defineHandler(
  firstMiddleware: MiddlewareFn,
  secondMiddleware: MiddlewareFn,
  thirdMiddleware: MiddlewareFn,
  handler: HandlerFn,
): TypedHandler;
export function defineHandler(
  firstMiddleware: MiddlewareFn,
  secondMiddleware: MiddlewareFn,
  thirdMiddleware: MiddlewareFn,
  fourthMiddleware: MiddlewareFn,
  handler: HandlerFn,
): TypedHandler;
export function defineHandler(
  firstMiddleware: MiddlewareFn,
  secondMiddleware: MiddlewareFn,
  thirdMiddleware: MiddlewareFn,
  fourthMiddleware: MiddlewareFn,
  fifthMiddleware: MiddlewareFn,
  handler: HandlerFn,
): TypedHandler;
export function defineHandler(...args: Array<MiddlewareFn | HandlerFn>): TypedHandler {
  if (args.length === 1) {
    return args[0] as TypedHandler;
  }
  const middlewares = args.slice(0, -1) as Array<MiddlewareFn>;
  const handler = args[args.length - 1] as HandlerFn;

  return (async (c: CloudContext) => {
    let index = 0;
    const dispatch = async (): Promise<void> => {
      if (index < middlewares.length) {
        const middleware = middlewares[index++];
        const middlewareResponse = await middleware(c, dispatch);
        if (middlewareResponse instanceof Response) {
          c.res = middlewareResponse;
        }
      } else {
        c.res = convertReturnValue(await handler(c));
      }
    };
    await dispatch();
    return c.res;
  }) as TypedHandler;
}

/**
 * Create a handler with input validation using Standard Schema validators.
 *
 * ```ts
 * export const POST = defineHandler.withValidator({
 *   body: mySchema,
 * })((c, { body }) => {
 *   return { received: body };
 * });
 * ```
 */
export namespace defineHandler {
  export function withValidator<V extends ValidatorSlots>(
    validators: V,
  ): <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R) => TypedHandler<V, R> {
    return <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R): TypedHandler<V, R> => {
      return (async (c: CloudContext) => {
        const result = await runValidation(validators, c);
        if (!result.ok) {
          return result.response;
        }
        return convertReturnValue(await handler(c, result.input));
      }) as TypedHandler<V, R>;
    };
  }
}

/**
 * Identity function that provides type inference for middleware.
 * At runtime it simply returns the function passed to it.
 */
export function defineMiddleware(
  handler: MiddlewareHandler<CloudEnv>,
): MiddlewareHandler<CloudEnv> {
  return handler;
}

const basicAuthEncoder = new TextEncoder();
const basicAuthDecoder = new TextDecoder('utf-8', { fatal: true });

function parseBasicAuthHeader(authorization: string | null) {
  if (!authorization?.toLowerCase().startsWith('basic ')) {
    return null;
  }

  try {
    const encoded = authorization.slice(6).trim();
    const bytes = base64ToBytes(encoded);
    const decoded = basicAuthDecoder.decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function timingSafeStringEqual(actual: string, expected: string) {
  const actualBytes = basicAuthEncoder.encode(actual);
  const expectedBytes = basicAuthEncoder.encode(expected);
  let difference = actualBytes.length ^ expectedBytes.length;

  for (let i = 0; i < expectedBytes.length; i++) {
    difference |= (actualBytes[i] ?? 0) ^ expectedBytes[i];
  }

  return difference === 0;
}

function isVoidInternalPath(pathname: string) {
  return pathname === '/__void' || pathname.startsWith('/__void/');
}

function basicAuthChallenge(realm: string, message: string) {
  const escapedRealm = realm.replace(/["\\]/g, '\\$&');

  return new Response(message, {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Basic realm="${escapedRealm}", charset="UTF-8"`,
    },
  });
}

function resolveBasicAuthOption(value: BasicAuthOptionValue | undefined, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  return typeof value === 'function' ? value() : value;
}

/**
 * Create Basic authentication middleware for temporary site gates and
 * pre-launch protection.
 *
 * Void internal endpoints under `/__void` are always excluded so deploy-time
 * migrations, prerendering, cron/queue dispatch, and remote binding helpers
 * continue to reach Void's own internal-token checks.
 */
export function basicAuth(options: BasicAuthOptions): MiddlewareHandler<CloudEnv> {
  return defineMiddleware(async (c, next) => {
    if (isVoidInternalPath(c.req.path)) {
      await next();
      return;
    }

    const username = resolveBasicAuthOption(options.username, '');
    const password = resolveBasicAuthOption(options.password, '');
    // An unset secret must not turn into a gate that accepts an empty password.
    if (!password) {
      throw new Error(
        'basicAuth: the password resolved to an empty value. Set the credential before serving requests.',
      );
    }
    const credentials = parseBasicAuthHeader(c.req.raw.headers.get('Authorization'));
    const usernameMatches = credentials && timingSafeStringEqual(credentials.username, username);
    const passwordMatches = credentials && timingSafeStringEqual(credentials.password, password);

    if (!usernameMatches || !passwordMatches) {
      const realm = resolveBasicAuthOption(options.realm, 'Restricted');
      const message = resolveBasicAuthOption(options.message, 'Authentication required');
      return basicAuthChallenge(realm, message);
    }

    await next();
  });
}

/**
 * Identity function that provides type inference for scheduled jobs.
 * At runtime it simply returns the function passed to it.
 */
export function defineScheduled(handler: ScheduledFn): ScheduledFn {
  return handler;
}

/**
 * Identity function that provides type inference for SSR render entry.
 * The second argument includes asset tags for client scripts/styles.
 */
export function defineRender(handler: RenderFn): RenderFn {
  return handler;
}

/**
 * Identity function that provides type inference for page `head()` exports.
 * At runtime it simply returns the function passed to it.
 */
export function defineHead<P = Record<string, unknown>>(
  handler: (c: CloudContext, props: P) => HeadDescriptor | undefined,
): (c: CloudContext, props: P) => HeadDescriptor | undefined {
  return handler;
}

/**
 * Identity function that provides type inference for queue consumers.
 * At runtime it simply returns the function passed to it.
 */
export function defineQueue<T = unknown>(handler: QueueFn<T>): TypedQueueHandler<T> {
  return handler as TypedQueueHandler<T>;
}

export type { ValidatorSlots, HandlerInput } from './validator.ts';
export { ValidationError } from '../pages/validation-error.ts';
export { defer } from '../pages/defer.ts';
export type { Deferred, InferProps } from '../pages/defer.ts';

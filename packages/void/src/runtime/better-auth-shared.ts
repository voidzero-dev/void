import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { Context } from 'hono';
import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import {
  VOID_EMAIL_AUTH_PROVIDER,
  getVoidAuthProviderEnvNames,
  getVoidAuthProviderSettingEnvNames,
  isVoidSocialAuthProvider,
  type VoidAuthProvider,
  type VoidSocialAuthProvider,
} from '../auth/providers.ts';
import { authContext, type AuthState, type VoidAuthConfig } from './auth.ts';

export type VoidAuthDialect = 'sqlite' | 'postgresql' | 'mysql';

export type VoidAuthRuntimeOptions = {
  dialect: VoidAuthDialect;
  providers: Array<VoidAuthProvider> | null;
  userConfig?: VoidAuthConfig;
  dev?: boolean;
  /**
   * Exact request paths whose responses are public and cached (the image
   * optimizer endpoint). Anonymous requests skip the session lookup;
   * credentialed requests still resolve the user for guard middleware, but the
   * response gets no auth headers (Set-Cookie, `private, no-store`).
   */
  skipPaths?: ReadonlyArray<string>;
};

export type VoidAuthEnv = Record<string, unknown> & {
  DB?: D1Database;
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString?: string };
  BETTER_AUTH_SECRET?: string;
};

type AuthDatabase = NonNullable<BetterAuthOptions['database']>;
type ApplyMigrations = (
  env: VoidAuthEnv,
  migrationSchema: VoidAuthMigrationSchema,
) => Promise<void>;
type EmailPasswordOptions = NonNullable<BetterAuthOptions['emailAndPassword']>;
type PasswordOptions = NonNullable<EmailPasswordOptions['password']>;
type VoidAuthPasswordOptions = PasswordOptions & {
  hash: NonNullable<PasswordOptions['hash']>;
  verify: NonNullable<PasswordOptions['verify']>;
};

export type VoidAuthRuntimeApi = {
  resolveVoidAuthOptions(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<BetterAuthOptions>;
  createVoidAuth(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<ReturnType<typeof betterAuth>>;
  resolveVoidAuthState(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<AuthState | null>;
  runVoidAuthMiddleware(
    c: Context,
    next: () => Promise<void>,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<void>;
  handleVoidAuthRequest(
    c: Context,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<Response>;
  runVoidAuthMigrations(
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    migrationSchema: VoidAuthMigrationSchema,
  ): Promise<void>;
};

function resolveSecret(env: VoidAuthEnv, dev: boolean): string {
  const explicit =
    typeof env.BETTER_AUTH_SECRET === 'string' && env.BETTER_AUTH_SECRET.length > 0
      ? env.BETTER_AUTH_SECRET
      : undefined;
  if (explicit) {
    return explicit;
  }

  if (dev) {
    return 'void-dev-better-auth-secret-1234567890';
  }

  throw new Error('auth: Missing Better Auth secret. Set BETTER_AUTH_SECRET.');
}

function readEnvString(env: VoidAuthEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Local development uses `DATABASE_URL`; production uses the Hyperdrive binding. */
export function resolveConnectionString(
  env: VoidAuthEnv,
  database: 'PostgreSQL' | 'MySQL',
): string {
  const hyperdrive = env.HYPERDRIVE?.connectionString;
  const connectionString =
    readEnvString(env, 'DATABASE_URL') ??
    (typeof hyperdrive === 'string' && hyperdrive.length > 0 ? hyperdrive : undefined);
  if (!connectionString) {
    throw new Error(
      `auth: Better Auth requires DATABASE_URL for local ${database} dev or HYPERDRIVE in production.`,
    );
  }
  return connectionString;
}

const PASSWORD_SALT_LENGTH = 16;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16_384,
  maxmem: 128 * 16_384 * 16 * 2,
  p: 1,
  r: 16,
} as const;

function derivePasswordKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

export const voidAuthPassword: VoidAuthPasswordOptions = {
  async hash(password) {
    const salt = randomBytes(PASSWORD_SALT_LENGTH).toString('hex');
    const key = await derivePasswordKey(password, salt);
    return `${salt}:${key.toString('hex')}`;
  },
  async verify({ hash, password }) {
    const [salt, key, ...extra] = hash.split(':');
    if (!salt || !key || extra.length > 0) {
      return false;
    }

    const storedKey = Buffer.from(key, 'hex');
    if (key.length !== SCRYPT_KEY_LENGTH * 2 || storedKey.length !== SCRYPT_KEY_LENGTH) {
      return false;
    }

    const targetKey = await derivePasswordKey(password, salt);
    return timingSafeEqual(targetKey, storedKey);
  },
};

function resolveEmailAndPassword(
  configuredProviders: Array<VoidAuthProvider> | null,
): BetterAuthOptions['emailAndPassword'] | undefined {
  if (!configuredProviders || configuredProviders.includes(VOID_EMAIL_AUTH_PROVIDER)) {
    return {
      enabled: true,
      password: voidAuthPassword,
    };
  }
  return undefined;
}

type SocialProviderOptions = Record<string, string> & { clientId: string; clientSecret: string };

function resolveSocialProviderCredentials(
  env: VoidAuthEnv,
  provider: VoidSocialAuthProvider,
): SocialProviderOptions {
  const envNames = getVoidAuthProviderEnvNames(provider);
  const clientId = readEnvString(env, envNames.clientId);
  const clientSecret = readEnvString(env, envNames.clientSecret);

  if (!clientId || !clientSecret) {
    throw new Error(
      `auth: Missing credentials for provider '${provider}'. Set ${envNames.clientId} and ${envNames.clientSecret}, or remove '${provider}' from auth.providers.`,
    );
  }

  // auth.ts can supply settings that the env leaves out, so
  // assertSocialProviderSettings checks the final options.
  const settings: Record<string, string> = {};
  for (const [option, envName] of Object.entries(getVoidAuthProviderSettingEnvNames(provider))) {
    const value = readEnvString(env, envName);
    if (value) {
      settings[option] = value;
    }
  }

  return { ...settings, clientId, clientSecret };
}

/** Fail early when a configured provider still lacks a required setting after auth.ts runs. */
function assertSocialProviderSettings(
  options: BetterAuthOptions,
  configuredProviders: Array<VoidAuthProvider> | null,
): void {
  const socialProviders = options.socialProviders as Record<string, unknown> | undefined;
  for (const provider of configuredProviders ?? []) {
    if (!isVoidSocialAuthProvider(provider)) {
      continue;
    }
    // A function form resolves later, inside Better Auth; a disabled provider needs nothing.
    const config = socialProviders?.[provider];
    if (typeof config !== 'object' || config === null) {
      continue;
    }
    const values = config as Record<string, unknown>;
    if (values.enabled === false) {
      continue;
    }
    const missing = Object.entries(getVoidAuthProviderSettingEnvNames(provider)).filter(
      ([option]) => !values[option],
    );
    if (missing.length > 0) {
      const options = joinNames(missing.map(([option]) => option));
      throw new Error(
        `auth: Missing ${options} for the ${provider} provider. Set ${joinNames(missing.map(([, envName]) => envName))}, or set ${options} in auth.ts.`,
      );
    }
  }
}

/** `a`, `a and b`, `a, b and c`. */
function joinNames(names: Array<string>): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]!;
}

function resolveSocialProviders(
  env: VoidAuthEnv,
  configuredProviders: Array<VoidAuthProvider> | null,
): BetterAuthOptions['socialProviders'] | undefined {
  if (!configuredProviders) {
    return undefined;
  }

  const providers: Record<string, SocialProviderOptions> = {};

  for (const provider of configuredProviders) {
    if (!isVoidSocialAuthProvider(provider)) {
      continue;
    }
    providers[provider] = resolveSocialProviderCredentials(env, provider);
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

function appendAuthHeaders(
  c: Context,
  source: Headers | undefined,
  includeCachePolicy: boolean,
): void {
  if (!source) {
    return;
  }

  // `no-store`, or `private` with `no-cache`, keeps the response out of shared
  // caches and makes the browser ask before reusing it, which allows ETag + 304
  // (the ETag must differ per user). `private` alone lets the browser show the
  // response to the next account that signs in.
  const routeDirectives = bareCacheDirectives(c.res.headers.get('cache-control'));
  const keepRoutePolicy =
    routeDirectives.has('no-store') ||
    (routeDirectives.has('private') && routeDirectives.has('no-cache'));
  source.forEach((value, key) => {
    // getSession's response policy belongs to the session endpoint. An anonymous
    // lookup must not make the application's public page or asset uncacheable.
    if (
      (!includeCachePolicy || keepRoutePolicy) &&
      ['cache-control', 'pragma'].includes(key.toLowerCase())
    ) {
      return;
    }
    c.header(key, value, {
      append: key.toLowerCase() === 'set-cookie',
    });
  });
  const sessionDirectives = bareCacheDirectives(source.get('cache-control'));
  if (
    source.has('set-cookie') &&
    !keepRoutePolicy &&
    !['private', 'no-store', 'no-cache'].some((directive) => sessionDirectives.has(directive))
  ) {
    c.header('Cache-Control', 'private, no-store');
  }
}

// Lowercased Cache-Control directive names that carry no value. Commas inside a
// quoted value do not split directives, so `no-cache="a,private"` has no `private`.
function bareCacheDirectives(policy: string | null): Set<string> {
  const directives = (policy ?? '').match(/(?:[^",]|"(?:[^"\\]|\\.)*"?)+/g) ?? [];
  return new Set(
    directives
      .map((directive) => directive.trim().toLowerCase())
      .filter((directive) => !directive.includes('=')),
  );
}

function resolveUserConfig(
  userConfig: VoidAuthConfig | undefined,
  defaults: BetterAuthOptions,
  request: Request,
  env: VoidAuthEnv,
  dialect: VoidAuthDialect,
): BetterAuthOptions {
  const mergeEmailAndPasswordDefaults = (options: BetterAuthOptions): BetterAuthOptions => {
    if (!defaults.emailAndPassword?.password || !options.emailAndPassword) {
      return options;
    }

    return {
      ...options,
      emailAndPassword: {
        ...options.emailAndPassword,
        password: options.emailAndPassword.password ?? defaults.emailAndPassword.password,
      },
    };
  };

  if (!userConfig) {
    return defaults;
  }

  if (typeof userConfig === 'function') {
    return mergeEmailAndPasswordDefaults(userConfig({ defaults, request, env, dialect }));
  }

  return mergeEmailAndPasswordDefaults({ ...defaults, ...userConfig });
}

const SESSION_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// An http page never counts for an https request. An https page counts for an
// http request on the same host: Vite HTTPS dev and preview hand WebSocket
// upgrades to the Worker with an http:// URL.
function isRequestOrigin(origin: string, requestUrl: string): boolean {
  try {
    const from = new URL(origin);
    const to = new URL(requestUrl);
    return from.host === to.host && (from.protocol === to.protocol || from.protocol === 'https:');
  } catch {
    return false;
  }
}

/**
 * Headers used to look up the signed-in session for app routes and WebSockets.
 *
 * The session cookie is SameSite=Lax, so a page on another origin of the same
 * site (for example a sibling subdomain) can still send it with a WebSocket
 * handshake or a POST that needs no CORS preflight. For those requests the
 * cookie only counts when the Origin is the request origin or one Better Auth
 * trusts, following Better Auth's own origin check for its endpoints. The
 * request is not rejected; it is resolved without a user.
 */
async function sessionHeaders(
  request: Request,
  auth: ReturnType<typeof betterAuth>,
): Promise<Headers> {
  const headers = request.headers;
  if (!headers.has('cookie')) {
    return headers;
  }
  if (
    SESSION_SAFE_METHODS.has(request.method) &&
    headers.get('upgrade')?.toLowerCase() !== 'websocket'
  ) {
    return headers;
  }
  const origin = headers.get('origin');
  if (!origin || isRequestOrigin(origin, request.url)) {
    return headers;
  }
  if (origin === 'null' && headers.get('sec-fetch-site') === 'same-origin') {
    return headers;
  }

  // Better Auth skips its origin check when CSRF checks are off, and treats
  // `disableOriginCheck: true` the same way while `disableCSRFCheck` is unset.
  const advanced = auth.options.advanced;
  if (
    advanced?.disableCSRFCheck === true ||
    (advanced?.disableOriginCheck === true && advanced.disableCSRFCheck === undefined)
  ) {
    return headers;
  }

  const context = await auth.$context;
  if (context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
    return headers;
  }
  // The function form is evaluated per request by Better Auth, while the
  // context list was built once without a request. `isTrustedOrigin` matches
  // against `this.trustedOrigins`, so reuse it to keep wildcard patterns.
  const trustedOrigins = auth.options.trustedOrigins;
  if (typeof trustedOrigins === 'function') {
    const requestOrigins = (await trustedOrigins(request)).filter((value): value is string =>
      Boolean(value),
    );
    if (
      context.isTrustedOrigin.call({ trustedOrigins: requestOrigins }, origin, {
        allowRelativePaths: false,
      })
    ) {
      return headers;
    }
  }

  const withoutCookie = new Headers(headers);
  withoutCookie.delete('cookie');
  console.warn(
    `auth: Ignored the session cookie on a ${request.method} request from ${origin}. Add this origin to auth trustedOrigins if it should use the signed-in session.`,
  );
  return withoutCookie;
}

const LOOPBACK_IP = /^(127\.|::1$|::ffff:127\.)/;

/**
 * The client IP set by Cloudflare's edge, or null outside a deployed Worker.
 * `request.cf` keeps a client-supplied header from being trusted on Node, Bun
 * or Deno, and local previews report a loopback address.
 */
function cloudflareClientIp(request: Request): string | null {
  const cf = (request as { cf?: unknown }).cf;
  if (typeof cf !== 'object' || cf === null) {
    return null;
  }
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || LOOPBACK_IP.test(ip)) {
    return null;
  }
  return ip;
}

/**
 * Better Auth enables rate limiting only when NODE_ENV is "production", which
 * Workers never set. Turn it on for deployed Cloudflare requests and key it by
 * Cloudflare's client IP header. Explicit user settings still win.
 */
function applyCloudflareRateLimitDefaults(options: BetterAuthOptions): BetterAuthOptions {
  return {
    ...options,
    rateLimit: {
      ...options.rateLimit,
      enabled: options.rateLimit?.enabled ?? true,
    },
    advanced: {
      ...options.advanced,
      ipAddress: options.advanced?.ipAddress ?? { ipAddressHeaders: ['cf-connecting-ip'] },
    },
  };
}

export function createVoidAuthRuntime(
  dialect: VoidAuthDialect,
  applyMigrations: ApplyMigrations,
): VoidAuthRuntimeApi {
  function assertDialect(received: VoidAuthDialect): void {
    if (received !== dialect) {
      throw new Error(`auth: Runtime mismatch. Expected ${dialect}, received '${received}'.`);
    }
  }

  async function resolveVoidAuthOptions(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<BetterAuthOptions> {
    assertDialect(runtime.dialect);

    const origin = new URL(request.url).origin;
    const emailAndPassword = resolveEmailAndPassword(runtime.providers);
    const socialProviders = resolveSocialProviders(env, runtime.providers);

    const defaults: BetterAuthOptions = {
      baseURL: origin,
      basePath: '/api/auth',
      secret: resolveSecret(env, runtime.dev === true),
      database,
      ...(emailAndPassword ? { emailAndPassword } : {}),
      ...(socialProviders ? { socialProviders } : {}),
      trustedOrigins: [origin],
    };

    const resolved = resolveUserConfig(runtime.userConfig, defaults, request, env, dialect);
    assertSocialProviderSettings(resolved, runtime.providers);
    return runtime.dev !== true && cloudflareClientIp(request)
      ? applyCloudflareRateLimitDefaults(resolved)
      : resolved;
  }

  async function createVoidAuth(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<ReturnType<typeof betterAuth>> {
    return betterAuth(await resolveVoidAuthOptions(request, env, runtime, database));
  }

  async function resolveVoidAuthState(
    request: Request,
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<AuthState | null> {
    const auth = await createVoidAuth(request, env, runtime, database);
    const result = await auth.api.getSession({
      headers: await sessionHeaders(request, auth),
      asResponse: false,
      returnHeaders: true,
    });

    return (result.response ?? null) as AuthState | null;
  }

  async function runVoidAuthMiddleware(
    c: Context,
    next: () => Promise<void>,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<void> {
    const credentialed = ['cookie', 'authorization', 'cf-access-jwt-assertion'].some((header) =>
      c.req.raw.headers.has(header),
    );
    // Public cached responses (the image optimizer) keep the session for guard
    // middleware but never carry auth headers.
    const publicPath = runtime.skipPaths?.includes(c.req.path) === true;
    // Skip auth for internal routes (cron, queue, migration, binding proxy) and
    // anonymous requests for public paths. Still set user/session to null so
    // downstream middleware that checks these context variables gets the
    // expected sentinel (not undefined).
    if (c.req.path.startsWith('/__') || (publicPath && !credentialed)) {
      c.set('user', null);
      c.set('session', null);
      return next();
    }

    const auth = await createVoidAuth(c.req.raw, c.env as VoidAuthEnv, runtime, database);
    c.set('__voidAuth', auth);

    const result = await auth.api.getSession({
      headers: await sessionHeaders(c.req.raw, auth),
      // The refreshed cookie would be dropped below, so leave the refresh to pages.
      ...(publicPath ? { query: { disableRefresh: true } } : {}),
      asResponse: false,
      returnHeaders: true,
    });

    const state = (result.response ?? null) as AuthState | null;
    c.set('user', state?.user ?? null);
    c.set('session', state?.session ?? null);

    await authContext.run({ user: state?.user ?? null, state }, async () => {
      await next();
    });

    if (publicPath) {
      return;
    }
    appendAuthHeaders(
      c,
      result.headers,
      state !== null || credentialed || result.headers?.has('set-cookie') === true,
    );
  }

  async function handleVoidAuthRequest(
    c: Context,
    runtime: VoidAuthRuntimeOptions,
    database: AuthDatabase,
  ): Promise<Response> {
    const existingAuth = c.get('__voidAuth') as ReturnType<typeof betterAuth> | undefined;
    if (existingAuth) {
      return existingAuth.handler(c.req.raw);
    }

    const auth = await createVoidAuth(c.req.raw, c.env as VoidAuthEnv, runtime, database);
    return auth.handler(c.req.raw);
  }

  async function runVoidAuthMigrations(
    env: VoidAuthEnv,
    runtime: VoidAuthRuntimeOptions,
    migrationSchema: VoidAuthMigrationSchema,
  ): Promise<void> {
    assertDialect(runtime.dialect);
    assertDialect(migrationSchema.dialect);
    await applyMigrations(env, migrationSchema);
  }

  return {
    resolveVoidAuthOptions,
    createVoidAuth,
    resolveVoidAuthState,
    runVoidAuthMiddleware,
    handleVoidAuthRequest,
    runVoidAuthMigrations,
  };
}

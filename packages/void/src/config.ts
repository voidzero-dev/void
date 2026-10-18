import { isRecord } from '@void/deploy-core';
import type { RewriteDestination } from 'void/routes';
import {
  VOID_AUTH_PROVIDERS,
  isVoidAuthProvider,
  type VoidAuthProvider,
} from './auth/providers.ts';
import type { DevRedirectRule, HeaderRule } from './cli/types.ts';
import { loadVoidConfig } from './config-loader.ts';
import { validateImagesConfig } from './image-config.ts';
import type { ImageConfig } from './image/config.ts';
import type { HeadConfig } from './pages/head.ts';
import { validateSourceDir } from './project-paths.ts';
import { MimeError, parseAddress } from './runtime/email/mime.ts';
import type { SandboxConfig, SandboxInstanceType } from './sandbox/config.ts';

/** Redirect destination — string (302) or object with explicit status. */
export type RedirectDestination = string | { to: string; status?: 301 | 302 | 303 | 307 | 308 };

/** Supported database dialects (internal representation). */
export type DatabaseDialect = 'sqlite' | 'postgresql' | 'mysql';

/** Curated Worker fields accepted by the `worker` config field. */
export type WranglerConfig = {
  compatibility_date?: string;
  compatibility_flags?: Array<string>;
  vars?: Record<string, string>;
  limits?: { cpu_ms?: number };
};

/**
 * How the asset layer answers a request that matched no asset and no worker
 * route. Mirrors Cloudflare's `assets.not_found_handling`.
 */
export type NotFoundHandling = 'single-page-application' | '404-page' | 'none';

/** Routing configuration — headers, redirects, rewrites, fallbacks, revalidation, prerendering. */
export type RoutingConfig = {
  /** Disable ISR and edge prerendering, including per-page policies. Static output is unaffected. */
  isr?: boolean;
  revalidate?: number | Record<string, number>;
  revalidateQueryAllowlist?: Record<string, Array<string>>;
  prerender?: Array<string>;
  headers?: Record<string, Array<string>>;
  redirects?: Record<string, RedirectDestination>;
  rewrites?: Record<string, RewriteDestination>;
  fallbacks?: Record<string, RewriteDestination>;
  /**
   * Override the inferred `not_found_handling` for the asset layer.
   *
   * Void infers `single-page-application` whenever the worker does not own HTML
   * routing, because a real SPA needs `/index.html` served for deep links. An
   * app whose assets were emitted by a static site generator (VitePress,
   * Docusaurus, …) wants the opposite: unknown URLs should serve the generator's
   * own `404.html` with a real HTTP 404, not `index.html` with a 200. Nothing in
   * a built asset tree distinguishes the two, so this is an explicit opt-in.
   *
   * Only `not_found_handling` is affected — `run_worker_first` is unchanged, so
   * API routes, auth, and `/__void/*` still reach the worker first.
   */
  notFound?: NotFoundHandling;
};

/** Inference configuration — bindings, scanDirs, build, outputDir, appType. */
export type InferenceConfig = {
  bindings?: {
    db?: boolean | string;
    kv?: boolean | string;
    storage?: boolean | string;
    ai?: boolean | string;
    email?: boolean;
    images?: boolean | string;
  };
  scanDirs?: ReadonlyArray<string>;
  build?: string;
  outputDir?: string;
  appType?: 'spa' | 'static' | 'void' | 'framework';
};

/** Auth configuration — high-level provider selection for Better Auth defaults. */
export type AuthConfig = {
  providers?: Array<VoidAuthProvider>;
};

/** AI configuration — the Cloudflare AI Gateway used by `ai.provider().fetch()` on self-hosted deploys (Workers AI `ai.run`/`ai.image` use the `env.AI` binding directly). */
export type AiConfig = {
  gateway?: string;
};

/**
 * Email configuration. `from` is the default sender for `sendEmail()` — one
 * address, optionally with a display name (`Acme <noreply@mail.acme.com>`) —
 * and, on `void deploy --platform cloudflare`, its host is the domain the CLI
 * sets Email Routing and Email Sending up on.
 */
export type EmailConfig = {
  from?: string;
};

/** Deployment choices owned by Void rather than passed to the Worker config. */
export type DeployConfig = {
  cloudflare?: { mode?: 'staged' | 'atomic' };
};

/** Cloudflare Worker configuration passed through to the native deploy artifact. */
type CloudflareField<T> = T & Record<string, unknown>;

export type CloudflareConfig = Record<string, unknown> & {
  account_id?: string;
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: Array<string>;
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars?: Record<string, unknown>;
  routes?: Array<
    string | CloudflareField<{ pattern: string; zone_name?: string; zone_id?: string }>
  >;
  route?: string | CloudflareField<{ pattern: string; zone_name?: string; zone_id?: string }>;
  d1_databases?: Array<
    CloudflareField<{
      binding: string;
      database_name?: string;
      database_id?: string;
      migrations_dir?: string;
      migrations_table?: string;
    }>
  >;
  kv_namespaces?: Array<CloudflareField<{ binding: string; id?: string; preview_id?: string }>>;
  r2_buckets?: Array<
    CloudflareField<{ binding: string; bucket_name?: string; preview_bucket_name?: string }>
  >;
  hyperdrive?: Array<CloudflareField<{ binding: string; id?: string }>>;
  queues?: CloudflareField<{
    producers?: Array<CloudflareField<{ binding: string; queue: string }>>;
    consumers?: Array<
      CloudflareField<{
        queue: string;
        max_batch_size?: number;
        max_batch_timeout?: number;
        max_retries?: number;
        dead_letter_queue?: string;
      }>
    >;
  }>;
  assets?: CloudflareField<{
    directory?: string;
    binding?: string;
    not_found_handling?: NotFoundHandling;
    run_worker_first?: boolean | Array<string>;
  }>;
  triggers?: CloudflareField<{ crons?: Array<string> }>;
  send_email?: Array<
    CloudflareField<{
      name: string;
      destination_address?: string;
      allowed_destination_addresses?: Array<string>;
      allowed_sender_addresses?: Array<string>;
    }>
  >;
  addresses?: Array<string>;
};

/** Shape of the Void project config. All fields optional. */
export type VoidConfig = {
  sourceDir?: string;
  target?: 'cloudflare' | 'node' | 'bun' | 'deno';
  output?: 'server' | 'static';
  auth?: AuthConfig;
  head?: HeadConfig;
  routing?: RoutingConfig;
  inference?: InferenceConfig;
  sandbox?: boolean | SandboxConfig;
  remote?: boolean;
  worker?: WranglerConfig;
  cloudflare?: CloudflareConfig;
  deploy?: DeployConfig;
  database?: 'pg' | 'mysql';
  ai?: AiConfig;
  email?: EmailConfig;
  /** Image optimization for `Image` components and the `/_void/image` endpoint (Next.js `images`). */
  images?: ImageConfig;
};

const CONFIG_FILE = 'void.json';

const VALID_TARGETS = new Set(['cloudflare', 'node', 'bun', 'deno']);
const VALID_APP_TYPES = new Set(['spa', 'static', 'void', 'framework']);
const VALID_OUTPUTS = new Set(['server', 'static']);
/**
 * Accepted `routing.notFound` values. Keep in sync with the schema.json enum
 * and `AssetConfig.not_found_handling` in `@void/deploy-core`.
 */
const VALID_NOT_FOUND_HANDLING: Set<string> = new Set([
  'single-page-application',
  '404-page',
  'none',
]);
/**
 * Allowed 3xx redirect statuses. Source of truth for the framework, the
 * `_redirects` parser (`cli/headers.ts`), and the schema.json enum. 303 is
 * included for POST→GET after-submit patterns; 304/305/306 aren't
 * cacheable-safe / are deprecated.
 */
export const VALID_REDIRECT_STATUSES: Set<number> = new Set([301, 302, 303, 307, 308]);
const VALID_DATABASE_VALUES = new Set(['pg', 'mysql']);
/** Cloudflare's hard maximum for Workers CPU time per request (5 minutes). */
const MAX_WORKER_CPU_MS = 300000;
const VALID_SANDBOX_INSTANCE_TYPES = new Set<SandboxInstanceType>([
  'lite',
  'standard-1',
  'standard-2',
  'standard-3',
  'standard-4',
]);
const SANDBOX_STRING_KEYS = [
  'binding',
  'className',
  'containerName',
  'image',
  'imageBuildContext',
  'platformImage',
];
const SANDBOX_KEYS = [...SANDBOX_STRING_KEYS, 'instanceType'];

/**
 * Count anonymous `*` wildcards, ignoring the `*` that ends a `:name*` capture:
 * `compilePattern` (`@void/edge`) gives `:name*` its own group, so it never clashes with a splat.
 */
export function countSplats(source: string): number {
  return source.replace(/:[A-Za-z0-9_]+\*/g, '').match(/\*/g)?.length ?? 0;
}

/**
 * Reject a rule source containing more than one anonymous `*` wildcard. Only
 * the first `*` is captured (as `:splat`), so a second one is ambiguous.
 * `kind` is a capitalised noun (e.g. "Redirect", "Rewrite") used in the error
 * text.
 */
function assertSingleSplat(source: string, kind: string): void {
  const count = countSplats(source);
  if (count > 1) {
    throw new Error(
      `${kind} source "${source}" in ${CONFIG_FILE} must contain at most one "*" wildcard (got ${count}); the matched portion is captured once as :splat`,
    );
  }
}

/**
 * Reject patterns that compile to duplicate named groups (`/:id/:id`, or `:splat`
 * with a bare `*`). The runtime would only skip such a rule with a log warning.
 */
function assertUniqueCaptureNames(source: string, kind: string): void {
  const seen = new Set<string>();
  const dups = new Set<string>();
  // Same identifier class as `compilePattern`. Trailing `*` is optional —
  // `:name` and `:name*` both produce a `<name>` capture group.
  const captureNameRe = /:([A-Za-z0-9_]+)\*?/g;
  let captureMatch: RegExpExecArray | null;
  while ((captureMatch = captureNameRe.exec(source)) !== null) {
    const name = captureMatch[1]!;
    if (seen.has(name)) {
      dups.add(name);
    }
    seen.add(name);
  }
  // Bare `*` (post-`:name*` strip) emits `(?<splat>...)`. If the pattern
  // also has a `:splat` token, both produce the same group name.
  if (countSplats(source) >= 1 && seen.has('splat')) {
    dups.add('splat');
  }
  if (dups.size > 0) {
    const names = [...dups].map((name) => `:${name}`).join(', ');
    throw new Error(
      `${kind} source "${source}" in ${CONFIG_FILE} has duplicate capture group name(s) (${names}); each :name token must be unique within a pattern, and :splat collides with a bare "*"`,
    );
  }
}

/** A leading `//` parses as `https://host/path`, so an internal rule would proxy cross-origin. */
export function isProtocolRelative(dest: string): boolean {
  return dest.startsWith('//');
}

function assertNotProtocolRelative(
  dest: string,
  source: string,
  kind: 'Redirect' | 'Rewrite' | 'Fallback',
): void {
  if (!isProtocolRelative(dest)) {
    return;
  }
  const suffix =
    kind === 'Redirect'
      ? 'use a single-slash path for internal redirects or an explicit "https://..." URL for external'
      : 'only internal paths are supported';
  throw new Error(
    `${kind} destination for "${source}" in ${CONFIG_FILE} must not start with "//" (protocol-relative URLs parse as cross-origin; ${suffix})`,
  );
}

// Mirrors LITERAL_HOSTNAME_REGEX in @void/deploy-core and the platform domains route.
const LITERAL_HOSTNAME_REGEX = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

type ParsedRuleSource = {
  host: string | undefined;
  path: string;
};

/**
 * Split an optional `https://host` prefix from a rule source. The host is
 * lowercased (dispatch compares `url.hostname`), and a bare `https://host` gets
 * path `/`. Returns `{ error }` for `//` and `http://` sources (only HTTPS
 * requests reach the runtime) and for non-literal hosts.
 */
export function parseHostPrefixedSource(raw: string): ParsedRuleSource | { error: string } {
  if (raw.startsWith('//')) {
    return {
      error: `must not start with "//" (protocol-relative URLs are ambiguous; use "/path" for path-only or "https://host/path")`,
    };
  }
  if (raw.startsWith('http://')) {
    return {
      error: `must not start with "http://" (TLS terminates upstream of the worker; only "https://" requests reach the runtime — use "https://host/path" instead)`,
    };
  }
  if (!raw.startsWith('https://')) {
    return { host: undefined, path: raw };
  }

  // Find the first `/` after `https://` — that's where the path starts.
  const afterScheme = raw.slice('https://'.length);
  const slashIdx = afterScheme.indexOf('/');
  const rawHost = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
  const path = slashIdx === -1 ? '/' : afterScheme.slice(slashIdx);
  const host = rawHost.toLowerCase();
  if (!LITERAL_HOSTNAME_REGEX.test(host)) {
    return {
      error: `host must be a literal hostname (e.g. "https://www.example.com/path"; no port, wildcards, or userinfo): ${JSON.stringify(rawHost)}`,
    };
  }
  return { host, path };
}

/**
 * Shared guard for rewrite/fallback destinations: they preserve the incoming
 * request's query string, so embedding one in the destination would silently
 * override (or merge confusingly with) the request query.
 */
function assertNoQueryString(dest: string, source: string, kind: 'Rewrite' | 'Fallback'): void {
  if (!dest.includes('?')) {
    return;
  }
  throw new Error(
    `${kind} destination for "${source}" in ${CONFIG_FILE} must not contain "?" (query strings are not supported in ${kind.toLowerCase()} destinations; the incoming request's query is preserved automatically)`,
  );
}

function validateRewriteMap(value: unknown, kind: 'Rewrite' | 'Fallback'): void {
  if (!isRecord(value)) {
    throw new Error(`"routing.${kind.toLowerCase()}s" in ${CONFIG_FILE} must be an object`);
  }
  for (const [source, dest] of Object.entries(value)) {
    const parsed = parseHostPrefixedSource(source);
    if ('error' in parsed) {
      throw new Error(`${kind} source "${source}" in ${CONFIG_FILE}: ${parsed.error}`);
    }
    if (!parsed.path.startsWith('/')) {
      throw new Error(
        `${kind} source "${source}" in ${CONFIG_FILE} must start with "/" (or be "https://host/path" with a path-absolute path)`,
      );
    }
    assertSingleSplat(parsed.path, kind);
    assertUniqueCaptureNames(parsed.path, kind);
    if (typeof dest !== 'string') {
      throw new Error(`${kind} destination for "${source}" in ${CONFIG_FILE} must be a string`);
    }
    if (!dest.startsWith('/')) {
      throw new Error(
        `${kind} destination for "${source}" in ${CONFIG_FILE} must start with "/" (only internal paths are supported)`,
      );
    }
    assertNotProtocolRelative(dest, source, kind);
    assertNoQueryString(dest, source, kind);
  }
}

/** Old flat keys that have moved into namespaces. */
const MIGRATION_ERRORS: Record<string, string> = {
  bindings: '"bindings" has moved to "inference.bindings"',
  build: '"build" has moved to "inference.build"',
  scanDirs: '"scanDirs" has moved to "inference.scanDirs"',
  appType: '"appType" has moved to "inference.appType"',
  outputDir: '"outputDir" has moved to "inference.outputDir"',
  headers: '"headers" has moved to "routing.headers"',
  redirects: '"redirects" has moved to "routing.redirects"',
  cache:
    '"cache" has been replaced by "routing" — use "routing.revalidate" and "routing.prerender"',
  wrangler: '"wrangler" has been renamed to "worker"',
  mode: '"mode" has been renamed to "inference.appType"',
  revalidate: '"revalidate" has moved to "routing.revalidate"',
};

/** Read and validate the project's typed config, with legacy JSON compatibility. */
export function readConfig(root: string): VoidConfig {
  const loaded = loadVoidConfig(root);
  return loaded ? validateConfig(loaded.value, loaded.source) : {};
}

/** Runtime validation also applies to TypeScript configs, whose types may be bypassed. */
export function validateConfig(config: unknown, source: string = CONFIG_FILE): VoidConfig {
  try {
    return validateConfigObject(config);
  } catch (error) {
    if (source !== CONFIG_FILE && error instanceof Error) {
      throw new Error(error.message.replaceAll(CONFIG_FILE, source), { cause: error });
    }
    throw error;
  }
}

function validateConfigObject(obj: unknown): VoidConfig {
  if (!isRecord(obj)) {
    throw new Error(`config: ${CONFIG_FILE} must be a JSON object.`);
  }

  // Check for old flat keys that have moved
  for (const [key, message] of Object.entries(MIGRATION_ERRORS)) {
    if (obj[key] !== undefined) {
      throw new Error(`config: ${message} in ${CONFIG_FILE}.`);
    }
  }

  // Validate sourceDir
  if (obj.sourceDir !== undefined) {
    if (typeof obj.sourceDir !== 'string') {
      throw new Error(`config: "sourceDir" in ${CONFIG_FILE} must be a string.`);
    }
    validateSourceDir(obj.sourceDir);
  }

  // Validate target
  if (obj.target !== undefined) {
    if (typeof obj.target !== 'string' || !VALID_TARGETS.has(obj.target)) {
      throw new Error(
        `config: "target" in ${CONFIG_FILE} must be one of: cloudflare, node, bun, deno.`,
      );
    }
  }

  // Validate output
  if (obj.output !== undefined) {
    if (typeof obj.output !== 'string' || !VALID_OUTPUTS.has(obj.output)) {
      throw new Error(`config: "output" in ${CONFIG_FILE} must be one of: server, static.`);
    }
  }

  // Validate auth
  if (obj.auth !== undefined) {
    if (!isRecord(obj.auth)) {
      throw new Error(`config: "auth" in ${CONFIG_FILE} must be an object.`);
    }

    const auth = obj.auth;
    for (const key of Object.keys(auth)) {
      if (key !== 'providers') {
        throw new Error(`config: Unknown key 'auth.${key}' in ${CONFIG_FILE}. Valid: providers.`);
      }
    }

    if (auth.providers !== undefined) {
      if (!Array.isArray(auth.providers)) {
        throw new Error(`config: "auth.providers" in ${CONFIG_FILE} must be an array of strings.`);
      }
      if (auth.providers.length === 0) {
        throw new Error(`config: "auth.providers" in ${CONFIG_FILE} must not be empty.`);
      }

      const seen = new Set<string>();
      for (const provider of auth.providers) {
        if (typeof provider !== 'string') {
          throw new Error(
            `config: "auth.providers" in ${CONFIG_FILE} must be an array of strings.`,
          );
        }
        if (!isVoidAuthProvider(provider)) {
          throw new Error(
            `config: "auth.providers" value '${provider}' in ${CONFIG_FILE} must be one of: ${VOID_AUTH_PROVIDERS.join(', ')}.`,
          );
        }
        if (seen.has(provider)) {
          throw new Error(
            `config: "auth.providers" in ${CONFIG_FILE} must not contain duplicates.`,
          );
        }
        seen.add(provider);
      }
    }
  }

  // Validate head
  if (obj.head !== undefined) {
    if (!isRecord(obj.head)) {
      throw new Error(`config: "head" in ${CONFIG_FILE} must be an object.`);
    }
    const h = obj.head;
    if (h.title !== undefined && typeof h.title !== 'string') {
      throw new Error(`config: "head.title" in ${CONFIG_FILE} must be a string.`);
    }
    if (h.titleTemplate !== undefined && typeof h.titleTemplate !== 'string') {
      throw new Error(`config: "head.titleTemplate" in ${CONFIG_FILE} must be a string.`);
    }
    if (h.meta !== undefined) {
      if (!Array.isArray(h.meta)) {
        throw new Error(`config: "head.meta" in ${CONFIG_FILE} must be an array.`);
      }
      for (const entry of h.meta) {
        if (!isRecord(entry)) {
          throw new Error(`config: "head.meta" entries in ${CONFIG_FILE} must be objects.`);
        }
      }
    }
    if (h.link !== undefined) {
      if (!Array.isArray(h.link)) {
        throw new Error(`config: "head.link" in ${CONFIG_FILE} must be an array.`);
      }
    }
    if (h.script !== undefined) {
      if (!Array.isArray(h.script)) {
        throw new Error(`config: "head.script" in ${CONFIG_FILE} must be an array.`);
      }
    }
    if (h.htmlAttrs !== undefined) {
      if (!isRecord(h.htmlAttrs)) {
        throw new Error(`config: "head.htmlAttrs" in ${CONFIG_FILE} must be an object.`);
      }
    }
    if (h.bodyAttrs !== undefined) {
      if (!isRecord(h.bodyAttrs)) {
        throw new Error(`config: "head.bodyAttrs" in ${CONFIG_FILE} must be an object.`);
      }
    }
  }

  // Validate routing
  if (obj.routing !== undefined) {
    if (!isRecord(obj.routing)) {
      throw new Error(`config: "routing" in ${CONFIG_FILE} must be an object.`);
    }
    const routing = obj.routing;

    // Validate routing.notFound
    if (routing.notFound !== undefined) {
      if (typeof routing.notFound !== 'string' || !VALID_NOT_FOUND_HANDLING.has(routing.notFound)) {
        throw new Error(
          `config: "routing.notFound" in ${CONFIG_FILE} must be one of: ${[...VALID_NOT_FOUND_HANDLING].join(', ')}.`,
        );
      }
    }

    if (routing.isr !== undefined && typeof routing.isr !== 'boolean') {
      throw new Error(`config: "routing.isr" in ${CONFIG_FILE} must be a boolean.`);
    }

    // Validate routing.revalidate
    if (routing.revalidate !== undefined) {
      if (typeof routing.revalidate === 'number') {
        if (!Number.isFinite(routing.revalidate) || routing.revalidate < 0) {
          throw new Error(
            `config: "routing.revalidate" in ${CONFIG_FILE} must be a non-negative finite number.`,
          );
        }
      } else if (isRecord(routing.revalidate)) {
        for (const [pattern, value] of Object.entries(routing.revalidate)) {
          if (pattern !== '*' && !pattern.startsWith('/')) {
            throw new Error(
              `config: "routing.revalidate" key '${pattern}' in ${CONFIG_FILE} must start with "/" or be "*".`,
            );
          }
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(
              `config: "routing.revalidate" value for '${pattern}' in ${CONFIG_FILE} must be a non-negative finite number.`,
            );
          }
        }
      } else {
        throw new Error(
          `config: "routing.revalidate" in ${CONFIG_FILE} must be a number or an object of path patterns to numbers.`,
        );
      }
    }

    // Validate routing.prerender
    if (routing.prerender !== undefined) {
      if (
        !Array.isArray(routing.prerender) ||
        !routing.prerender.every((p) => typeof p === 'string')
      ) {
        throw new Error(
          `config: "routing.prerender" in ${CONFIG_FILE} must be an array of strings.`,
        );
      }
      for (const p of routing.prerender as Array<string>) {
        if (!p.startsWith('/')) {
          throw new Error(
            `config: "routing.prerender" path '${p}' in ${CONFIG_FILE} must start with "/".`,
          );
        }
      }
    }

    // Validate routing.headers
    if (routing.headers !== undefined) {
      if (!isRecord(routing.headers)) {
        throw new Error(`config: "routing.headers" in ${CONFIG_FILE} must be an object.`);
      }
      for (const [pattern, values] of Object.entries(routing.headers)) {
        if (!pattern.startsWith('/')) {
          throw new Error(
            `config: Header pattern '${pattern}' in ${CONFIG_FILE} must start with "/".`,
          );
        }
        assertSingleSplat(pattern, 'Header');
        if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
          throw new Error(
            `config: Headers for '${pattern}' in ${CONFIG_FILE} must be an array of strings.`,
          );
        }
      }
    }

    // Validate routing.redirects
    if (routing.redirects !== undefined) {
      if (!isRecord(routing.redirects)) {
        throw new Error(`config: "routing.redirects" in ${CONFIG_FILE} must be an object.`);
      }
      for (const [source, dest] of Object.entries(routing.redirects)) {
        const parsed = parseHostPrefixedSource(source);
        if ('error' in parsed) {
          throw new Error(
            `config: Redirect source '${source}' in ${CONFIG_FILE}: ${parsed.error}.`,
          );
        }
        if (!parsed.path.startsWith('/')) {
          throw new Error(
            `config: Redirect source '${source}' in ${CONFIG_FILE} must start with "/" (or be "https://host/path" with a path-absolute path).`,
          );
        }
        assertSingleSplat(parsed.path, 'Redirect');
        assertUniqueCaptureNames(parsed.path, 'Redirect');
        if (typeof dest === 'string') {
          assertNotProtocolRelative(dest, source, 'Redirect');
        } else if (isRecord(dest)) {
          if (typeof dest.to !== 'string') {
            throw new Error(
              `config: Redirect for '${source}' in ${CONFIG_FILE} must have a "to" string.`,
            );
          }
          assertNotProtocolRelative(dest.to, source, 'Redirect');
          if (dest.status !== undefined && !VALID_REDIRECT_STATUSES.has(dest.status as number)) {
            throw new Error(
              `config: Redirect status for '${source}' in ${CONFIG_FILE} must be 301, 302, 303, 307, or 308.`,
            );
          }
        } else {
          throw new Error(
            `config: Redirect for '${source}' in ${CONFIG_FILE} must be a string or an object with "to" and optional "status".`,
          );
        }
      }
    }

    // Validate routing.revalidateQueryAllowlist
    if (routing.revalidateQueryAllowlist !== undefined) {
      if (!isRecord(routing.revalidateQueryAllowlist)) {
        throw new Error(`"routing.revalidateQueryAllowlist" in ${CONFIG_FILE} must be an object`);
      }
      for (const [pattern, params] of Object.entries(routing.revalidateQueryAllowlist)) {
        if (pattern !== '*' && !pattern.startsWith('/')) {
          throw new Error(
            `config: revalidateQueryAllowlist pattern '${pattern}' in ${CONFIG_FILE} must start with "/" or be "*".`,
          );
        }
        if (pattern !== '*') {
          assertSingleSplat(pattern, 'revalidateQueryAllowlist');
        }
        if (!Array.isArray(params) || !params.every((v) => typeof v === 'string')) {
          throw new Error(
            `config: revalidateQueryAllowlist for '${pattern}' in ${CONFIG_FILE} must be an array of strings.`,
          );
        }
      }
    }

    if (routing.rewrites !== undefined) {
      validateRewriteMap(routing.rewrites, 'Rewrite');
    }
    if (routing.fallbacks !== undefined) {
      validateRewriteMap(routing.fallbacks, 'Fallback');
    }
  }

  // Validate inference
  if (obj.inference !== undefined) {
    if (!isRecord(obj.inference)) {
      throw new Error(`config: "inference" in ${CONFIG_FILE} must be an object.`);
    }
    const inf = obj.inference;

    if (inf.auth !== undefined) {
      throw new Error(
        `config: "inference.auth" in ${CONFIG_FILE} is no longer supported. Use auth.ts or import from "void/auth"/"void/client" instead.`,
      );
    }

    // Validate inference.bindings
    if (inf.bindings !== undefined) {
      if (!isRecord(inf.bindings)) {
        throw new Error(`config: "inference.bindings" in ${CONFIG_FILE} must be an object.`);
      }
      const b = inf.bindings;
      for (const key of Object.keys(b)) {
        if (!['db', 'kv', 'storage', 'ai', 'email', 'images'].includes(key)) {
          throw new Error(
            `config: Unknown binding '${key}' in ${CONFIG_FILE}. Valid: db, kv, storage, ai, email, images.`,
          );
        }
        if (key === 'email') {
          if (typeof b[key] !== 'boolean') {
            throw new Error(
              `config: "inference.bindings.${key}" in ${CONFIG_FILE} must be a boolean.`,
            );
          }
        } else {
          if (typeof b[key] !== 'boolean' && typeof b[key] !== 'string') {
            throw new Error(
              `config: "inference.bindings.${key}" in ${CONFIG_FILE} must be a boolean or a string custom binding name.`,
            );
          }
        }
      }
    }

    // Validate inference.build
    if (inf.build !== undefined && typeof inf.build !== 'string') {
      throw new Error(`config: "inference.build" in ${CONFIG_FILE} must be a string.`);
    }

    // Validate inference.scanDirs
    if (inf.scanDirs !== undefined) {
      if (!Array.isArray(inf.scanDirs) || !inf.scanDirs.every((d) => typeof d === 'string')) {
        throw new Error(
          `config: "inference.scanDirs" in ${CONFIG_FILE} must be an array of strings.`,
        );
      }
      for (const d of inf.scanDirs as Array<string>) {
        if (d.startsWith('/') || d.startsWith('..')) {
          throw new Error(
            `config: "inference.scanDirs" path '${d}' in ${CONFIG_FILE} must be a relative directory.`,
          );
        }
      }
    }

    // Validate inference.appType
    if (inf.appType !== undefined) {
      if (typeof inf.appType !== 'string' || !VALID_APP_TYPES.has(inf.appType)) {
        throw new Error(
          `config: "inference.appType" in ${CONFIG_FILE} must be one of: spa, static, void, framework.`,
        );
      }
    }

    // Validate inference.outputDir
    if (inf.outputDir !== undefined && typeof inf.outputDir !== 'string') {
      throw new Error(`config: "inference.outputDir" in ${CONFIG_FILE} must be a string.`);
    }
  }

  // Validate remote
  if (obj.remote !== undefined && typeof obj.remote !== 'boolean') {
    throw new Error(`config: "remote" in ${CONFIG_FILE} must be a boolean.`);
  }

  // Validate sandbox
  if (obj.sandbox !== undefined && typeof obj.sandbox !== 'boolean') {
    if (!isRecord(obj.sandbox)) {
      throw new Error(`config: "sandbox" in ${CONFIG_FILE} must be a boolean or an object.`);
    }
    const sandbox = obj.sandbox;
    for (const key of Object.keys(sandbox)) {
      if (!SANDBOX_KEYS.includes(key)) {
        throw new Error(
          `config: Unknown key 'sandbox.${key}' in ${CONFIG_FILE}. Valid: ${SANDBOX_KEYS.join(', ')}.`,
        );
      }
    }
    for (const key of SANDBOX_STRING_KEYS) {
      if (sandbox[key] !== undefined && typeof sandbox[key] !== 'string') {
        throw new Error(`config: "sandbox.${key}" in ${CONFIG_FILE} must be a string.`);
      }
    }
    if (
      sandbox.instanceType !== undefined &&
      (typeof sandbox.instanceType !== 'string' ||
        !VALID_SANDBOX_INSTANCE_TYPES.has(sandbox.instanceType as SandboxInstanceType))
    ) {
      throw new Error(
        `config: "sandbox.instanceType" in ${CONFIG_FILE} must be one of: ${[...VALID_SANDBOX_INSTANCE_TYPES].join(', ')}.`,
      );
    }
  }

  // Validate worker
  if (obj.worker !== undefined) {
    if (!isRecord(obj.worker)) {
      throw new Error(`config: "worker" in ${CONFIG_FILE} must be an object.`);
    }
    const w = obj.worker;
    if (w.compatibility_date !== undefined) {
      if (typeof w.compatibility_date !== 'string') {
        throw new Error(`config: "worker.compatibility_date" in ${CONFIG_FILE} must be a string.`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(w.compatibility_date)) {
        throw new Error(
          `config: "worker.compatibility_date" in ${CONFIG_FILE} must use YYYY-MM-DD format.`,
        );
      }
    }
    if (w.compatibility_flags !== undefined) {
      if (
        !Array.isArray(w.compatibility_flags) ||
        !w.compatibility_flags.every((f) => typeof f === 'string')
      ) {
        throw new Error(
          `config: "worker.compatibility_flags" in ${CONFIG_FILE} must be an array of strings.`,
        );
      }
    }
    if (w.vars !== undefined) {
      if (!isRecord(w.vars)) {
        throw new Error(`config: "worker.vars" in ${CONFIG_FILE} must be an object.`);
      }
      for (const [key, value] of Object.entries(w.vars)) {
        if (typeof value !== 'string') {
          throw new Error(`config: "worker.vars.${key}" in ${CONFIG_FILE} must be a string.`);
        }
      }
    }
    if (w.limits !== undefined) {
      if (!isRecord(w.limits)) {
        throw new Error(`config: "worker.limits" in ${CONFIG_FILE} must be an object.`);
      }
      const limits = w.limits;
      for (const key of Object.keys(limits)) {
        if (key !== 'cpu_ms') {
          throw new Error(
            `config: Unknown key 'worker.limits.${key}' in ${CONFIG_FILE}. Valid: cpu_ms.`,
          );
        }
      }
      if (limits.cpu_ms !== undefined) {
        if (
          typeof limits.cpu_ms !== 'number' ||
          !Number.isInteger(limits.cpu_ms) ||
          limits.cpu_ms < 1 ||
          limits.cpu_ms > MAX_WORKER_CPU_MS
        ) {
          throw new Error(
            `config: "worker.limits.cpu_ms" in ${CONFIG_FILE} must be an integer between 1 and ${MAX_WORKER_CPU_MS}.`,
          );
        }
      }
    }
  }

  // Cloudflare's complete Worker config is passed through to its build tooling.
  if (obj.cloudflare !== undefined) {
    if (!isRecord(obj.cloudflare)) {
      throw new Error(`config: "cloudflare" in ${CONFIG_FILE} must be an object.`);
    }
  }

  if (obj.deploy !== undefined) {
    if (!isRecord(obj.deploy)) {
      throw new Error(`config: "deploy" in ${CONFIG_FILE} must be an object.`);
    }
    const deploy = obj.deploy;
    for (const key of Object.keys(deploy)) {
      if (key !== 'cloudflare') {
        throw new Error(
          `config: Unknown key 'deploy.${key}' in ${CONFIG_FILE}. Valid: cloudflare.`,
        );
      }
    }
    if (deploy.cloudflare !== undefined) {
      if (!isRecord(deploy.cloudflare)) {
        throw new Error(`config: "deploy.cloudflare" in ${CONFIG_FILE} must be an object.`);
      }
      const cloudflareDeploy = deploy.cloudflare;
      for (const key of Object.keys(cloudflareDeploy)) {
        if (key !== 'mode') {
          throw new Error(
            `config: Unknown key 'deploy.cloudflare.${key}' in ${CONFIG_FILE}. Valid: mode.`,
          );
        }
      }
      if (
        cloudflareDeploy.mode !== undefined &&
        cloudflareDeploy.mode !== 'staged' &&
        cloudflareDeploy.mode !== 'atomic'
      ) {
        throw new Error(
          `config: "deploy.cloudflare.mode" in ${CONFIG_FILE} must be "staged" or "atomic".`,
        );
      }
    }
  }

  // Validate database
  if (obj.database !== undefined) {
    if (typeof obj.database !== 'string' || !VALID_DATABASE_VALUES.has(obj.database)) {
      throw new Error(`config: "database" in ${CONFIG_FILE} must be "pg" or "mysql".`);
    }
  }

  // Validate ai
  if (obj.ai !== undefined) {
    if (!isRecord(obj.ai)) {
      throw new Error(`config: "ai" in ${CONFIG_FILE} must be an object.`);
    }

    const aiCfg = obj.ai;
    for (const key of Object.keys(aiCfg)) {
      if (key !== 'gateway') {
        throw new Error(`config: Unknown key 'ai.${key}' in ${CONFIG_FILE}. Valid: gateway.`);
      }
    }

    if (
      aiCfg.gateway !== undefined &&
      (typeof aiCfg.gateway !== 'string' || aiCfg.gateway.length === 0)
    ) {
      throw new Error(`config: "ai.gateway" in ${CONFIG_FILE} must be a non-empty string.`);
    }
  }

  // Validate email
  if (obj.email !== undefined) {
    if (!isRecord(obj.email)) {
      throw new Error(`config: "email" in ${CONFIG_FILE} must be an object.`);
    }

    const emailCfg = obj.email;
    for (const key of Object.keys(emailCfg)) {
      if (key !== 'from') {
        throw new Error(`config: Unknown key 'email.${key}' in ${CONFIG_FILE}. Valid: from.`);
      }
    }

    if (emailCfg.from !== undefined) {
      parseEmailFrom(emailCfg.from);
    }
  }

  // Validate images
  validateImagesConfig(obj.images, CONFIG_FILE);

  // Legacy void.json files may carry an editor hint. It is not part of the
  // typed config and should never reach consumers of the resolved config.
  if ('$schema' in obj) {
    const resolved = { ...obj };
    delete resolved.$schema;
    return resolved as VoidConfig;
  }
  return obj as VoidConfig;
}

/**
 * Parse `email.from` with the runtime's own address parser, so the config
 * accepts exactly what `sendEmail()` accepts: one address, optionally with a
 * display name, and nothing that could split into two recipients or smuggle a
 * header. A sender that passes here cannot later fail `INVALID_FROM` on shape.
 */
function parseEmailFrom(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`config: "email.from" in ${CONFIG_FILE} must be a non-empty string.`);
  }
  try {
    parseAddress(value, 'email.from');
  } catch (error) {
    const detail = error instanceof MimeError ? ` ${error.message}` : '';
    throw new Error(
      `config: "email.from" in ${CONFIG_FILE} must be a single email address, optionally with a display name (e.g. "Acme <noreply@mail.acme.com>").${detail}`,
    );
  }
}

/** Returns true if the target is a non-Cloudflare runtime (Node.js, Bun, Deno). */
export function isNodeTarget(target: VoidConfig['target']): boolean {
  return target === 'node' || target === 'bun' || target === 'deno';
}

/**
 * Extract custom binding names from config. Returns only entries where
 * a string name was explicitly provided (not `true`).
 */
export function resolveBindingNames(
  bindings: InferenceConfig['bindings'],
): { d1?: string; kv?: string; r2?: string; ai?: string; images?: string } | undefined {
  if (!bindings) {
    return undefined;
  }
  const names: { d1?: string; kv?: string; r2?: string; ai?: string; images?: string } = {};
  let hasCustom = false;
  if (typeof bindings.db === 'string') {
    names.d1 = bindings.db;
    hasCustom = true;
  }
  if (typeof bindings.kv === 'string') {
    names.kv = bindings.kv;
    hasCustom = true;
  }
  if (typeof bindings.storage === 'string') {
    names.r2 = bindings.storage;
    hasCustom = true;
  }
  if (typeof bindings.ai === 'string') {
    names.ai = bindings.ai;
    hasCustom = true;
  }
  if (typeof bindings.images === 'string') {
    names.images = bindings.images;
    hasCustom = true;
  }
  return hasCustom ? names : undefined;
}

/**
 * Get the database dialect from config. Defaults to "sqlite".
 */
export function getDatabaseDialect(config: VoidConfig): DatabaseDialect {
  if (config.database === 'pg') {
    return 'postgresql';
  }
  if (config.database === 'mysql') {
    return 'mysql';
  }
  return 'sqlite';
}

/**
 * Convert the `headers` config field into `HeaderRule[]` for the deploy manifest.
 *
 * Each key is a URL pattern (e.g. "/assets/*") and each value is an array of
 * "Name: value" strings. Returns undefined if the input is empty or undefined.
 */
export function convertHeadersConfig(
  headers: Record<string, Array<string>> | undefined,
): Array<HeaderRule> | undefined {
  if (!headers) {
    return undefined;
  }

  const rules: Array<HeaderRule> = [];

  for (const [pattern, values] of Object.entries(headers)) {
    const parsed: Array<[string, string]> = [];
    for (const entry of values) {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) {
        continue;
      }
      const name = entry.slice(0, colonIdx).trim();
      const value = entry.slice(colonIdx + 1).trim();
      if (name) {
        parsed.push([name, value]);
      }
    }
    if (parsed.length > 0) {
      rules.push({ pattern, headers: parsed });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Convert the `redirects` config field into `DevRedirectRule[]` for the deploy manifest.
 *
 * Each key is a URL pattern (e.g. "/old") and each value is either a string
 * destination (defaults to 302) or an object with `to` and optional `status`.
 * Returns undefined if the input is empty or undefined.
 */
export function convertRedirectsConfig(
  redirects: Record<string, RedirectDestination> | undefined,
): Array<DevRedirectRule> | undefined {
  if (!redirects) {
    return undefined;
  }

  const origin = 'void.json#routing.redirects';
  const rules: Array<DevRedirectRule> = [];
  for (const [rawSource, dest] of Object.entries(redirects)) {
    const parsed = parseHostPrefixedSource(rawSource);
    if ('error' in parsed) {
      throw new Error(`convertRedirectsConfig: source "${rawSource}": ${parsed.error}`);
    }
    const { host, path } = parsed;
    const base = { source: path, status: 302, origin, ...(host && { host }) };
    if (typeof dest === 'string') {
      rules.push({ ...base, destination: dest });
    } else {
      rules.push({ ...base, destination: dest.to, status: dest.status ?? 302 });
    }
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Convert the `rewrites` config field into `DevRedirectRule[]` with status 200.
 *
 * Each key is a URL pattern (e.g. "/docs") and each value is a destination path.
 * Rewrites serve content from the destination without changing the browser URL.
 * Emits `force: true` so these rules fire unconditionally, overriding any
 * matching static asset (Netlify-compat `200!` semantics). Returns undefined
 * if the input is empty or undefined.
 */
export function convertRewritesConfig(
  rewrites: Record<string, RewriteDestination> | undefined,
): Array<DevRedirectRule> | undefined {
  return convertRewriteRules('convertRewritesConfig', rewrites, 'rewrites', true);
}

/**
 * Convert the `fallbacks` config field into `DevRedirectRule[]` with status 200.
 *
 * Fallbacks fire only when the static asset resolver would otherwise return
 * 404. They share the rewrite shape (status 200, pathname-only destination)
 * but are evaluated at a different pipeline phase — post-lookup instead of
 * pre-lookup. Emits `force: false` (Netlify-compat plain `200` semantics).
 * Returns undefined if the input is empty or undefined.
 */
export function convertFallbacksConfig(
  fallbacks: Record<string, RewriteDestination> | undefined,
): Array<DevRedirectRule> | undefined {
  return convertRewriteRules('convertFallbacksConfig', fallbacks, 'fallbacks', false);
}

function convertRewriteRules(
  caller: string,
  entries: Record<string, RewriteDestination> | undefined,
  field: 'rewrites' | 'fallbacks',
  force: boolean,
): Array<DevRedirectRule> | undefined {
  if (!entries) {
    return undefined;
  }

  const origin = `void.json#routing.${field}`;
  const rules: Array<DevRedirectRule> = [];
  for (const [rawSource, destination] of Object.entries(entries)) {
    const parsed = parseHostPrefixedSource(rawSource);
    if ('error' in parsed) {
      throw new Error(`${caller}: source "${rawSource}": ${parsed.error}`);
    }
    const { host, path } = parsed;
    rules.push({
      source: path,
      destination,
      status: 200,
      force,
      origin,
      ...(host && { host }),
    });
  }

  return rules.length > 0 ? rules : undefined;
}

/**
 * Public env API — `void/env`.
 *
 * Canonical usage:
 *
 * ```ts
 * // env.ts at project root
 * import { defineEnv, string, number, oneOf } from "void/env";
 *
 * export default defineEnv({
 *   STRIPE_KEY: string(),
 *   PORT: number().default(3000),
 *   NODE_ENV: oneOf(["development", "production"]),
 *   VITE_APP_TITLE: string(),
 * });
 *
 * // anywhere else
 * import { env } from "void/env";
 * env.STRIPE_KEY;
 * ```
 *
 * The `env` proxy reads from the underlying runtime env (Cloudflare worker
 * bindings, Node `process.env`, Nuxt globals, etc.) via `getRuntimeEnv()`,
 * and validates each key on first access using the registered schema.
 *
 * Bindings (`DB`, `KV`, `STORAGE`, `AI`, queue handlers) and other env keys
 * not declared in the schema pass through unchanged.
 */
/// <reference types="@cloudflare/workers-types" />

import { isUnmaskActive, redactMessage } from '../shared/env-mask.ts';
import type { StandardSchemaV1 } from '../standard-schema.ts';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw.ts';
import { getRuntimeEnv, isInternalBinding } from './env.ts';

type AnyValidator = StandardSchemaV1<unknown, unknown>;
type AnySchema = Record<string, AnyValidator>;

type BootValidationState = { ok: true } | { ok: false; error: EnvValidationError };
type EnvRegistryState = {
  schema: AnySchema | null;
  hasDefineEnvBeenCalled: boolean;
  bootValidation: BootValidationState | null;
};

// Tooling can load `void/env` through a different module instance than the Vite
// plugin (source workspace, built package, or cache-busted HMR import). Keep the
// registry process-global so every instance observes the same schema.
const ENV_REGISTRY_SYMBOL = Symbol.for('void.env.registry');
const registryGlobal = globalThis as typeof globalThis & {
  [ENV_REGISTRY_SYMBOL]?: EnvRegistryState;
};
const registry = (registryGlobal[ENV_REGISTRY_SYMBOL] ??= {
  schema: null,
  hasDefineEnvBeenCalled: false,
  bootValidation: null,
});
const validatedCache = new WeakMap<object, Map<string, unknown>>();
// WeakMap does not expose its values; keep a parallel list so defineEnv can clear them.
const cacheList: Array<Map<string, unknown>> = [];

function getValidatedCache(rawEnv: object): Map<string, unknown> {
  let cache = validatedCache.get(rawEnv);
  if (!cache) {
    cache = new Map();
    validatedCache.set(rawEnv, cache);
    cacheList.push(cache);
  }
  return cache;
}

/** Vite embeds the same public build inputs into server and browser bundles. */
function getClientEnvValues(): Record<string, unknown> {
  const values = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(([key]) => key.startsWith('VITE_')),
  );
}

/**
 * Type-only stub for the validated env shape. Augmented by the generated
 * `.void/env.d.ts` so `env.X` is typed per the user's schema. Includes an
 * index signature so untyped property access returns `unknown` (rather than
 * a hard error) for bindings and keys not declared in the schema.
 */
export interface ValidatedEnv {
  readonly [key: string]: unknown;
}

type InferEnv<S extends AnySchema> = {
  readonly [K in keyof S]: StandardSchemaV1.InferOutput<S[K]>;
};

/**
 * Register an env schema and return the typed `env` proxy.
 *
 * Calling `defineEnv` is the only required step — Void auto-discovers
 * `env.ts` at project root, imports it, and uses the schema for runtime
 * validation, type generation, and deploy-time secret checks.
 *
 * The return value is identical to the `env` export from `void/env`.
 * Re-export it from your `env.ts` if you prefer the explicit
 * `import { env } from "~/env"` pattern.
 */
export function defineEnv<S extends AnySchema>(schema: S): InferEnv<S> {
  registry.schema = schema;
  // Flip the presence flag once and leave it on — even if a future call
  // swaps in an empty schema, we still know defineEnv was declared.
  registry.hasDefineEnvBeenCalled = true;
  // Drop any cached entries from a prior schema (HMR / re-import).
  for (const map of cacheList) {
    map.clear();
  }
  // Reset boot-time validation state so a re-imported schema is re-checked.
  registry.bootValidation = null;
  return env as unknown as InferEnv<S>;
}

/**
 * Internal: validate the whole schema against the worker env once per isolate,
 * from the generated worker entry. Catches remote-secret values the deploy CLI
 * cannot see. Async validators are awaited here and their values cached, so
 * later synchronous `env.X` reads can serve them.
 */
export async function _validateEnvOnce(envValues: unknown): Promise<void> {
  if (registry.bootValidation) {
    if (!registry.bootValidation.ok) {
      throw registry.bootValidation.error;
    }
    return;
  }
  if (!registry.schema) {
    registry.bootValidation = { ok: true };
    return;
  }
  // Public values belong to this build, not to the remote secret store. Keep
  // server rendering and boot validation consistent with the browser bundle.
  const values = {
    ...((envValues ?? {}) as Record<string, unknown>),
    ...getClientEnvValues(),
  };
  const report = await validateAllEnvWithValues(registry.schema, values);
  if (report.valid) {
    // Seed the per-key cache, keyed by the raw env as in `readKey`.
    try {
      const cacheKey = getRawRuntimeEnv() as object;
      const cache = getValidatedCache(cacheKey);
      for (const [key, value] of report.values) {
        // Internal bindings stay hidden even when the schema declares them.
        if (isInternalBinding(key, cacheKey as RuntimeEnv)) {
          continue;
        }
        if (!cache.has(key)) {
          cache.set(key, value);
        }
      }
    } catch {
      // No runtime env available — no proxy reads will happen, so no seeding needed.
    }
    registry.bootValidation = { ok: true };
    return;
  }
  const lines: Array<string> = ['Env validation failed at worker boot:'];
  for (const key of report.missing) {
    lines.push(`  • ${key} is required but missing`);
  }
  for (const { key, messages } of report.invalid) {
    // Messages are already redacted inside validateAllEnvWithValues.
    lines.push(`  • ${key}: ${messages.join('; ')}`);
  }
  const error = new EnvValidationError('__init__', [{ message: lines.join('\n') }]);
  registry.bootValidation = { ok: false, error };
  throw error;
}

/** Internal: framework-only access to the registered schema (for plugin/CLI). */
export function _getRegisteredSchema(): AnySchema | null {
  return registry.schema;
}

/**
 * Internal: returns `true` once `defineEnv()` has been called at least once,
 * regardless of whether the caller passed an empty schema. Gives tooling a
 * reliable signal — `_getRegisteredSchema()` alone can't distinguish
 * `defineEnv({})` (an intentional empty schema) from "never called".
 */
export function _hasRegisteredSchema(): boolean {
  return registry.hasDefineEnvBeenCalled;
}

/**
 * Internal: extract `.default(value)` values from the registered schema as
 * stringified env values. Used for explicit build-time client fallbacks.
 *
 * Detection is schema-agnostic: probe each validator with `undefined` and,
 * if it succeeds with a non-undefined value, that value is the default.
 * Works for our built-in `.default(...)` helpers and for any Standard
 * Schema validator with intrinsic default behaviour. Async validators are
 * skipped (we can't get a sync default).
 *
 * Keys with no default — required keys and plain `.optional()` keys — are omitted.
 */
export function _getSchemaDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {};
  if (!registry.schema) {
    return defaults;
  }
  for (const [key, validator] of Object.entries(registry.schema)) {
    let result: unknown;
    try {
      result = validator['~standard'].validate(undefined);
    } catch {
      continue;
    }
    if (result instanceof Promise) {
      continue;
    }
    const r = result as { value?: unknown; issues?: unknown };
    if (r.issues) {
      continue;
    }
    if (r.value === undefined || r.value === null) {
      continue;
    }
    defaults[key] = typeof r.value === 'string' ? r.value : String(r.value);
  }
  return defaults;
}

export class EnvValidationError extends Error {
  readonly key: string;
  readonly issues: Array<StandardSchemaV1.Issue>;

  constructor(key: string, issues: Array<StandardSchemaV1.Issue>) {
    // Callers redact messages first; the raw value is not known here.
    super(`Invalid env "${key}": ${issues.map((i) => i.message).join(', ')}`);
    this.name = 'EnvValidationError';
    this.key = key;
    this.issues = issues;
  }
}

function readKey(key: string): unknown {
  // Internal bindings stay hidden even when the schema declares them.
  const rawEnv = getRawRuntimeEnv();
  if (isInternalBinding(key, rawEnv)) {
    return undefined;
  }
  const filtered = getRuntimeEnv() as Record<string, unknown>;
  const clientValues = getClientEnvValues();
  const rawValue = Object.hasOwn(clientValues, key) ? clientValues[key] : filtered[key];
  if (!registry.schema) {
    return rawValue;
  }
  const validator = registry.schema[key];
  if (!validator) {
    return rawValue;
  }
  // Cache identity must be the underlying env object. `getRuntimeEnv()`
  // returns a fresh Proxy on every call, so keying by it would miss.
  const cache = getValidatedCache(rawEnv);
  if (cache.has(key)) {
    return cache.get(key);
  }
  const result = validator['~standard'].validate(rawValue);
  if (result instanceof Promise) {
    throw new Error(
      `env: Async validator for '${key}' cannot be resolved synchronously. ` +
        `Proxy property access is synchronous, so async Standard Schema ` +
        `validators must be pre-resolved by calling \`_validateEnvOnce(env)\` ` +
        `at worker boot (Void splices this into the generated entry) or by ` +
        `awaiting \`validateAllEnv(env)\` before the first \`env.${key}\` read. ` +
        `Once pre-validated, the resolved value is cached and served synchronously here.`,
    );
  }
  if (result.issues) {
    const unmask = isUnmaskActive();
    const redactedIssues = result.issues.map((i) => ({
      ...i,
      message: redactMessage(rawValue, i.message, { unmask }),
    }));
    throw new EnvValidationError(key, redactedIssues);
  }
  cache.set(key, result.value);
  return result.value;
}

/**
 * Typed env proxy. Reads from the runtime env, validating declared keys
 * on first access and passing through bindings / unknown keys unchanged.
 * Async validators must be resolved first by `_validateEnvOnce()`.
 */
export const env = new Proxy({} as Record<string, unknown>, {
  get(_target, key) {
    if (typeof key === 'symbol') {
      return undefined;
    }
    return readKey(key);
  },
  has(_target, key) {
    if (typeof key === 'symbol') {
      return false;
    }
    return Object.hasOwn(getClientEnvValues(), key) || Reflect.has(getRuntimeEnv() as object, key);
  },
  ownKeys() {
    return [
      ...new Set([...Reflect.ownKeys(getRuntimeEnv()), ...Object.keys(getClientEnvValues())]),
    ];
  },
  getOwnPropertyDescriptor(_target, key) {
    if (typeof key === 'symbol') {
      return undefined;
    }
    return {
      enumerable: true,
      configurable: true,
      value: readKey(String(key)),
    };
  },
}) as ValidatedEnv;

/** Aggregate report from validating an entire env object against the schema. */
export type EnvValidationReport = {
  valid: boolean;
  missing: Array<string>;
  invalid: Array<{ key: string; messages: Array<string> }>;
  /**
   * Resolved values for keys that validated successfully. Used to seed the
   * per-env cache after async pre-validation so sync `env.X` reads hit the
   * cache.
   */
  values: Map<string, unknown>;
};

/**
 * Validate an env record (local dotenv, build inputs, or runtime bindings) against
 * the registered schema. Used by the dev plugin (warnings), the deploy CLI
 * (hard error), and `_validateEnvOnce` at worker boot.
 *
 * Async: awaits any validators that return a `Promise` (zod async refines,
 * arktype narrows, etc.). Callers already run in async contexts.
 */
export async function validateAllEnv(
  envValues: Record<string, unknown>,
): Promise<EnvValidationReport> {
  if (!registry.schema) {
    return { valid: true, missing: [], invalid: [], values: new Map() };
  }
  return await validateAllEnvWithValues(registry.schema, envValues);
}

/**
 * Internal: shared core that validates a schema against values and also
 * returns the resolved values (for cache seeding).
 */
async function validateAllEnvWithValues(
  schema: AnySchema,
  envValues: Record<string, unknown>,
): Promise<EnvValidationReport> {
  const report: EnvValidationReport = {
    valid: true,
    missing: [],
    invalid: [],
    values: new Map(),
  };
  const unmask = isUnmaskActive();
  for (const [key, validator] of Object.entries(schema)) {
    const raw = envValues[key];
    const resultMaybe = validator['~standard'].validate(raw);
    const result = resultMaybe instanceof Promise ? await resultMaybe : resultMaybe;
    if (result.issues) {
      report.valid = false;
      const isMissing = raw === undefined || raw === null || raw === '';
      if (isMissing) {
        report.missing.push(key);
      } else {
        report.invalid.push({
          key,
          messages: result.issues.map((i) => redactMessage(raw, i.message, { unmask })),
        });
      }
    } else {
      report.values.set(key, result.value);
    }
  }
  return report;
}

export { string, number, boolean, url, email, oneOf, json, type EnvSchema } from './env-helpers.ts';

// Ambient Cloudflare.Env declarations so user tsconfigs that include
// `types: ["void/env"]` expose D1/KV/R2 globals plus the auto-inferred Void
// framework bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KV: KVNamespace;
      STORAGE: R2Bucket;
      AI: Ai;
      SANDBOX: DurableObjectNamespace<import('./sandbox.ts').VoidPlatformSandbox>;
      ASSETS: Fetcher;
      /** @internal Service binding to proxy worker (AI, revalidation, future features) */
      __VOID_PROXY?: Fetcher;
      /** @internal Custom proxy URL override */
      __VOID_PROXY_URL?: string;
      /** @internal Auth token for HTTP proxy (local dev) */
      __VOID_TOKEN?: string;
      /** @internal Project ID for HTTP proxy (local dev) */
      __VOID_PROJECT_ID?: string;
      /** @internal Staging environment flag */
      __VOID_STAGING?: string;
      /** @internal Project ID (service binding path) */
      __PROJECT_ID?: string;
      /** @internal Proxy token (service binding path) */
      __VOID_PROXY_TOKEN?: string;
      [key: `QUEUE_${string}`]: Queue<unknown> | undefined;
    }
  }
}

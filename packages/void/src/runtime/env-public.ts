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

type BootValidationState =
  | { ok: true; values: Map<string, unknown> }
  | { ok: false; error: EnvValidationError };

/** A completed whole-schema validation, with the raw value of each key that it checked. */
type EnvValidation = {
  inputs: Map<string, unknown>;
  state: BootValidationState;
};

type EnvRegistryState = {
  schema: AnySchema | null;
  hasDefineEnvBeenCalled: boolean;
  /**
   * The latest completed whole-schema validation. An env with the same raw values reuses it,
   * also when each request brings a new env object. An env with other values is validated
   * again rather than given values validated for another. `readKey` serves a key's value from
   * here to an env that was not validated itself, while it holds the raw value that the value
   * came from.
   */
  validation?: EnvValidation | null;
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
});
// Replaced, not cleared, by defineEnv, so the cache of an env holds no reference once the env
// is gone.
let validatedCache = new WeakMap<object, Map<string, unknown>>();

function getValidatedCache(rawEnv: object): Map<string, unknown> {
  let cache = validatedCache.get(rawEnv);
  if (!cache) {
    cache = new Map();
    validatedCache.set(rawEnv, cache);
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
  validatedCache = new WeakMap();
  // Reset boot-time validation state so a re-imported schema is re-checked.
  registry.validation = null;
  return env as unknown as InferEnv<S>;
}

/**
 * Internal: validate the whole schema against the worker env, from the generated
 * worker entry. Catches remote-secret values the deploy CLI cannot see. A
 * completed validation is reused for the same raw values; an env with other
 * values is validated again. Async validators are awaited here, and their values
 * serve later synchronous `env.X` reads of the env this call receives, and of any
 * other env that holds the same raw values.
 */
export async function _validateEnvOnce(envValues: unknown): Promise<void> {
  const schema = registry.schema;
  if (!schema) {
    return;
  }
  const inputs = readSchemaInputs(schema, envValues);
  const last = registry.validation;
  let state: BootValidationState;
  if (last && sameInputs(last.inputs, inputs)) {
    state = last.state;
  } else {
    // Each call awaits its own validation until one completes. In workerd, a promise that
    // waits on another request's I/O never settles once that request is canceled.
    state = await validateSchema(schema, inputs);
    if (registry.schema !== schema) {
      // defineEnv registered another schema while this call waited.
      return _validateEnvOnce(envValues);
    }
    registry.validation = { inputs, state };
  }
  if (!state.ok) {
    throw state.error;
  }
  // Keep the values with the env that passed. The registry holds the latest validation only,
  // and an env with other values can validate while requests with this env still run:
  // Cloudflare may keep an isolate running when only its bindings change.
  seedValidated(envValues, state.values);
}

/** The raw value of each schema key that `readKey` would validate for this env. */
function readSchemaInputs(schema: AnySchema, envValues: unknown): Map<string, unknown> {
  const values = (typeof envValues === 'object' && envValues !== null ? envValues : {}) as Record<
    string,
    unknown
  >;
  // Public values belong to this build, not to the remote secret store. Keep
  // server rendering and boot validation consistent with the browser bundle.
  const clientValues = getClientEnvValues();
  return new Map(
    Object.keys(schema).map((key) => [
      key,
      Object.hasOwn(clientValues, key) ? clientValues[key] : values[key],
    ]),
  );
}

function sameInputs(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (!b.has(key) || !Object.is(b.get(key), value)) {
      return false;
    }
  }
  return true;
}

async function validateSchema(
  schema: AnySchema,
  inputs: Map<string, unknown>,
): Promise<BootValidationState> {
  const report = await validateAllEnvWithValues(schema, Object.fromEntries(inputs));
  if (report.valid) {
    return { ok: true, values: report.values };
  }
  const lines: Array<string> = ['Env validation failed at worker boot:'];
  for (const key of report.missing) {
    lines.push(`  • ${key} is required but missing`);
  }
  for (const { key, messages } of report.invalid) {
    // Messages are already redacted inside validateAllEnvWithValues.
    lines.push(`  • ${key}: ${messages.join('; ')}`);
  }
  return {
    ok: false,
    error: new EnvValidationError('__init__', [{ message: lines.join('\n') }]),
  };
}

/** Seed the per-key cache of `rawEnv`, where `readKey` looks first, with values validated for it. */
function seedValidated(rawEnv: unknown, values: Map<string, unknown>): void {
  if (typeof rawEnv !== 'object' || rawEnv === null || values.size === 0) {
    return;
  }
  const cache = getValidatedCache(rawEnv);
  for (const [key, value] of values) {
    // Internal bindings stay hidden even when the schema declares them. A value that a read
    // already returned stays the same object.
    if (!isInternalBinding(key, rawEnv as RuntimeEnv) && !cache.has(key)) {
      cache.set(key, value);
    }
  }
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
  // `env.hasOwnProperty` and the like come from Object.prototype, not from the schema.
  const validator = Object.hasOwn(registry.schema, key) ? registry.schema[key] : undefined;
  if (!validator) {
    return rawValue;
  }
  // Cache identity must be the underlying env object. `getRuntimeEnv()`
  // returns a fresh Proxy on every call, so keying by it would miss.
  const cache = getValidatedCache(rawEnv);
  if (cache.has(key)) {
    return cache.get(key);
  }
  // Validation seeds only the env object it receives. Reads also use objects it never
  // received: the `cloudflare:workers` env outside a request scope, the remote dev copy. A
  // validated value belongs to the raw value it came from, so the latest validation serves
  // such an env while it holds that raw value. The value is not cached: this env can come to
  // hold another.
  const latest = registry.validation;
  if (
    latest?.state.ok &&
    latest.state.values.has(key) &&
    Object.is(latest.inputs.get(key), rawValue)
  ) {
    return latest.state.values.get(key);
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
   * Resolved values for keys that validated successfully. After async
   * pre-validation they serve sync `env.X` reads.
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
 * returns the resolved values (for sync reads).
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

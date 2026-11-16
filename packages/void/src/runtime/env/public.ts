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
import { ENV_REGISTRY_KEY } from '../shared/env-registry.ts';
import type { StandardSchemaV1 } from '../standard-schema.ts';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw.ts';
import { getRuntimeEnv, isInternalBinding } from './env.ts';

type AnyValidator = StandardSchemaV1<unknown, unknown>;
type AnySchema = Record<string, AnyValidator>;

/** How one schema key validated against its raw value. */
type KeyResult =
  | { ok: true; value: unknown }
  | { ok: false; issues: Array<StandardSchemaV1.Issue> }
  | { ok: false; thrown: unknown };

/** A validation of every schema key, with the raw value that each key was validated against. */
type EnvValidation = {
  inputs: Map<string, unknown>;
  results: Map<string, KeyResult>;
  /** Why `_validateEnvOnce` rejects this validation, kept so that each call throws the same error. */
  error?: EnvValidationError;
};

type EnvRegistryState = {
  schema: AnySchema | null;
  hasDefineEnvBeenCalled: boolean;
  /**
   * The latest validation of every schema key. An env with the same raw values reuses it, also
   * when each request brings a new env object, unless a validator threw in it. An env with
   * other values is validated again rather than given results validated for another. `readKey`
   * serves a key's result from here to an env that was not validated itself, while it holds
   * the raw value that the result came from.
   */
  latestValidation?: EnvValidation | null;
  /**
   * Results by env object, from its validation and its reads. Replaced, not cleared, by
   * defineEnv, so the results of an env hold no reference once the env is gone. They live here
   * rather than in this module because one Worker can hold several copies of it: `void deploy`
   * bundles a framework app's cron and queue jobs apart from the app.
   */
  results?: WeakMap<object, Map<string, KeyResult>>;
  /**
   * `_prepareEnv` of the copy that registered the schema. Code bundled apart from the app
   * prepares the env with it, so the public values embedded with the app are the ones validated.
   */
  prepare?: (envValues: unknown) => Promise<void>;
};

// Tooling can load `void/env` through a different module instance than the Vite
// plugin (source workspace, built package, or cache-busted HMR import). Keep the
// registry process-global so every instance observes the same schema. Two Void
// versions in one process share it too: name a field anew when its shape changes.
const ENV_REGISTRY_SYMBOL = Symbol.for(ENV_REGISTRY_KEY);
const registryGlobal = globalThis as typeof globalThis & {
  [ENV_REGISTRY_SYMBOL]?: EnvRegistryState;
};
const registry = (registryGlobal[ENV_REGISTRY_SYMBOL] ??= {
  schema: null,
  hasDefineEnvBeenCalled: false,
});

/** The results of `rawEnv`, where `readKey` looks first. */
function getEnvResults(rawEnv: object): Map<string, KeyResult> {
  const byEnv = (registry.results ??= new WeakMap());
  let results = byEnv.get(rawEnv);
  if (!results) {
    results = new Map();
    byEnv.set(rawEnv, results);
  }
  return results;
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
  // Drop results from a prior schema (HMR / re-import), in every copy of this module.
  registry.results = new WeakMap();
  // Reset the latest validation so a re-imported schema is re-checked.
  registry.latestValidation = null;
  registry.prepare = _prepareEnv;
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
  const validation = await validateEnv(envValues);
  if (validation) {
    assertValid(validation);
  }
}

/**
 * Internal: validate every schema key against a framework Worker's env, from its generated
 * entry, so that synchronous `env.X` reads serve defaults, converted values and async
 * validators' results. Unlike `_validateEnvOnce`, this never rejects: a read of a key that
 * failed throws that key's error, so a request that does not read it still runs, and so does a
 * build-time prerender without production secrets. Validations are reused the same way.
 */
export async function _prepareEnv(envValues: unknown): Promise<void> {
  // Without an env, as in a prerender in Node, reads fail anyway.
  if (typeof envValues !== 'object' || envValues === null) {
    return;
  }
  await validateEnv(envValues);
}

/**
 * Validate every schema key for `envValues`, or reuse the latest validation of the same raw
 * values, and keep the results with `envValues` for its reads.
 */
async function validateEnv(envValues: unknown): Promise<EnvValidation | undefined> {
  const schema = registry.schema;
  if (!schema) {
    return undefined;
  }
  const inputs = readSchemaInputs(schema, envValues);
  let validation = registry.latestValidation;
  if (!validation || !isReusable(validation) || !sameInputs(validation.inputs, inputs)) {
    // Each call awaits its own validation until one completes. In workerd, a promise that
    // waits on another request's I/O never settles once that request is canceled.
    validation = { inputs, results: await validateKeys(schema, inputs) };
    if (registry.schema !== schema) {
      // defineEnv registered another schema while this call waited.
      return validateEnv(envValues);
    }
    registry.latestValidation = validation;
  }
  // Keep the results with the env they were validated for. The registry holds the latest
  // validation only, and an env with other values can validate while requests with this env
  // still run: Cloudflare may keep an isolate running when only its bindings change.
  keepResults(envValues, validation.results);
  return validation;
}

/** A validator that threw may succeed when it runs again, as a lookup that failed can. */
function isReusable(validation: EnvValidation): boolean {
  for (const result of validation.results.values()) {
    if ('thrown' in result) {
      return false;
    }
  }
  return true;
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

/**
 * Validate each schema key against its raw value, awaiting async validators. Never rejects: the
 * issues of a key, or what its validator threw, become that key's result.
 */
async function validateKeys(
  schema: AnySchema,
  inputs: Map<string, unknown>,
): Promise<Map<string, KeyResult>> {
  const unmask = isUnmaskActive();
  const entries = await Promise.all(
    Object.entries(schema).map(async ([key, validator]): Promise<[string, KeyResult]> => {
      const raw = inputs.get(key);
      try {
        const result = await validator['~standard'].validate(raw);
        if (result.issues) {
          return [key, { ok: false, issues: redactIssues(raw, result.issues, unmask) }];
        }
        return [key, { ok: true, value: result.value }];
      } catch (thrown) {
        return [key, { ok: false, thrown }];
      }
    }),
  );
  return new Map(entries);
}

/** Throw what fails the validation as a whole: what a validator threw, or every invalid key. */
function assertValid(validation: EnvValidation): void {
  if (validation.error) {
    throw validation.error;
  }
  const missing: Array<string> = [];
  const invalid: Array<string> = [];
  for (const [key, result] of validation.results) {
    if (result.ok) {
      continue;
    }
    if ('thrown' in result) {
      throw result.thrown;
    }
    if (isMissing(validation.inputs.get(key))) {
      missing.push(`  • ${key} is required but missing`);
    } else {
      // The messages are already redacted.
      invalid.push(`  • ${key}: ${result.issues.map((issue) => issue.message).join('; ')}`);
    }
  }
  if (missing.length > 0 || invalid.length > 0) {
    const lines = ['Env validation failed at worker boot:', ...missing, ...invalid];
    validation.error = new EnvValidationError('__init__', [{ message: lines.join('\n') }]);
    throw validation.error;
  }
}

/** Keep `results` with `rawEnv`, where its reads look first. */
function keepResults(rawEnv: unknown, results: Map<string, KeyResult>): void {
  if (typeof rawEnv !== 'object' || rawEnv === null) {
    return;
  }
  const kept = getEnvResults(rawEnv);
  for (const [key, result] of results) {
    // Internal bindings stay hidden even when the schema declares them. A value that a read
    // already returned stays the same object.
    if (!isInternalBinding(key, rawEnv as RuntimeEnv) && !kept.get(key)?.ok) {
      kept.set(key, result);
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
  // Results are keyed by the underlying env object. `getRuntimeEnv()`
  // returns a fresh Proxy on every call, so keying by it would miss.
  const results = getEnvResults(rawEnv);
  const known = results.get(key) ?? latestResult(key, rawValue);
  if (known) {
    if (known.ok) {
      return known.value;
    }
    if ('issues' in known) {
      throw new EnvValidationError(key, known.issues);
    }
    throw known.thrown;
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
    throw new EnvValidationError(key, redactIssues(rawValue, result.issues, isUnmaskActive()));
  }
  results.set(key, { ok: true, value: result.value });
  return result.value;
}

/**
 * Validation keeps results only with the env object it receives. Reads also use objects it
 * never received: the `cloudflare:workers` env outside a request scope, the remote dev copy. A
 * result belongs to the raw value it came from, so the latest validation serves such an env
 * while it holds that raw value. The result is not kept with this env: it can come to hold
 * another value.
 */
function latestResult(key: string, rawValue: unknown): KeyResult | undefined {
  const latest = registry.latestValidation;
  if (!latest || !Object.is(latest.inputs.get(key), rawValue)) {
    return undefined;
  }
  return latest.results.get(key);
}

/** Issues whose messages no longer contain the raw value, unless unmasking is on. */
function redactIssues(
  raw: unknown,
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
  unmask: boolean,
): Array<StandardSchemaV1.Issue> {
  return issues.map((issue) => ({
    ...issue,
    message: redactMessage(raw, issue.message, { unmask }),
  }));
}

/** A value that a required key counts as missing rather than invalid. */
function isMissing(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === '';
}

/**
 * Typed env proxy. Reads from the runtime env, validating declared keys
 * on first access and passing through bindings / unknown keys unchanged.
 * Async validators must be resolved first by `_validateEnvOnce()` or `_prepareEnv()`.
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
  /** Resolved values for keys that validated successfully. */
  values: Map<string, unknown>;
};

/**
 * Validate an env record (local dotenv, build inputs, or runtime bindings) against
 * the registered schema. Used by the dev plugin (warnings) and the deploy CLI
 * (hard error).
 *
 * Async: awaits any validators that return a `Promise` (zod async refines,
 * arktype narrows, etc.). Callers already run in async contexts.
 */
export async function validateAllEnv(
  envValues: Record<string, unknown>,
): Promise<EnvValidationReport> {
  const report: EnvValidationReport = {
    valid: true,
    missing: [],
    invalid: [],
    values: new Map(),
  };
  if (!registry.schema) {
    return report;
  }
  const unmask = isUnmaskActive();
  for (const [key, validator] of Object.entries(registry.schema)) {
    const raw = envValues[key];
    const resultMaybe = validator['~standard'].validate(raw);
    const result = resultMaybe instanceof Promise ? await resultMaybe : resultMaybe;
    if (result.issues) {
      report.valid = false;
      if (isMissing(raw)) {
        report.missing.push(key);
      } else {
        report.invalid.push({
          key,
          messages: redactIssues(raw, result.issues, unmask).map((issue) => issue.message),
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

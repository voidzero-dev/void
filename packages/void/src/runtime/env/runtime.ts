/**
 * Public runtime env API — exposed via "void/_env".
 *
 * All exports from this module are accessible to user code.
 * Internal platform bindings (__VOID_*, __PROJECT_*) are filtered
 * from getRuntimeEnv() and blocked in getRuntimeBinding().
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  envContext,
  asEnv,
  getRawRuntimeEnv,
  INTERNAL_BINDING_EXACT_NAMES,
  INTERNAL_BINDING_PREFIXES,
  isIsrActive,
  type RuntimeEnv,
} from './env-raw.ts';

export type { RuntimeEnv };

type RuntimeRequestScope = {
  resources: Map<object, unknown>;
};

// Shared across copies of this module for the reason given at `envContext`.
const REQUEST_SCOPE_SYMBOL: unique symbol = Symbol.for('void.runtimeRequestScope.v1');
const shared = globalThis as { [REQUEST_SCOPE_SYMBOL]?: AsyncLocalStorage<RuntimeRequestScope> };
shared[REQUEST_SCOPE_SYMBOL] ??= new AsyncLocalStorage<RuntimeRequestScope>();
const runtimeRequestContext = shared[REQUEST_SCOPE_SYMBOL];

/** @internal Reuse a resource only within the current runtime request. */
export function getRuntimeRequestResource<T>(
  key: object,
  initialize: () => T,
  outsideScope?: () => T,
): T {
  const scope = runtimeRequestContext.getStore();
  if (!scope) {
    if (outsideScope) {
      return outsideScope();
    }
    throw new Error('env: Request-scoped resource is unavailable outside a runtime handler.');
  }
  if (scope.resources.has(key)) {
    return scope.resources.get(key) as T;
  }
  const resource = initialize();
  scope.resources.set(key, resource);
  return resource;
}

export function withRuntimeEnv<T>(env: unknown, fn: () => T): T {
  const resolved = asEnv(env);
  if (!resolved) {
    return fn();
  }
  if (runtimeRequestContext.getStore()) {
    return envContext.run(resolved, fn);
  }

  const scope: RuntimeRequestScope = { resources: new Map() };
  return envContext.run(resolved, () => runtimeRequestContext.run(scope, fn));
}

/** Whether `name` is a framework binding hidden from user code; `rawEnv` is the unfiltered env. */
export function isInternalBinding(name: string, rawEnv: RuntimeEnv): boolean {
  if (INTERNAL_BINDING_PREFIXES.some((p) => name.startsWith(p))) {
    return true;
  }
  return (
    isIsrActive(rawEnv) && (INTERNAL_BINDING_EXACT_NAMES as ReadonlyArray<string>).includes(name)
  );
}

function filterEnvProxy(env: RuntimeEnv): RuntimeEnv {
  // The proxy target IS the raw env, so each trap consults `target` for the
  // ISR-active gate — no extra `getRawRuntimeEnv()` call needed.
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && isInternalBinding(prop, target)) {
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string' && isInternalBinding(prop, target)) {
        return false;
      }
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(
        (key) => typeof key !== 'string' || !isInternalBinding(key, target),
      );
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && isInternalBinding(prop, target)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/** Returns the runtime env with internal platform bindings hidden. */
export function getRuntimeEnv(): RuntimeEnv {
  return filterEnvProxy(getRawRuntimeEnv());
}

export function getRuntimeBinding<T = unknown>(name: string): T | undefined {
  const raw = getRawRuntimeEnv();
  if (isInternalBinding(name, raw)) {
    return undefined;
  }
  return raw[name] as T | undefined;
}

export function requireRuntimeBinding<T = unknown>(name: string): T {
  const value = getRuntimeBinding<T>(name);
  if (value !== undefined && value !== null) {
    return value;
  }
  throw new Error(`env: Missing Cloudflare binding '${name}'.`);
}

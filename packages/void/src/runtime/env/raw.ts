/**
 * Raw runtime env resolution — framework-internal only.
 *
 * This module is NOT exported in package.json, so it cannot be imported
 * via "void/..." subpaths. Only framework modules can import it by relative path.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type RuntimeEnv = Record<string, unknown>;

/** Prefixes for platform-internal bindings that must be hidden from user code. */
export const INTERNAL_BINDING_PREFIXES = ['__VOID_', '__PROJECT_'] as const;

/**
 * Framework bindings hidden from user code only while ISR is active, so a non-ISR
 * app keeps its own `ISR_CACHE`. Shared with the generated `c.env` filter.
 */
export const INTERNAL_BINDING_EXACT_NAMES = ['ISR_CACHE'] as const;

/** Only ISR builds stamp the `__VOID_ISR_DEPLOYMENT_ID` binding onto the raw env. */
export function isIsrActive(rawEnv: RuntimeEnv): boolean {
  return rawEnv.__VOID_ISR_DEPLOYMENT_ID != null;
}

/**
 * One process or isolate can evaluate this module more than once: Vite's SSR module
 * runner keeps its own copy beside a package it leaves external, and a dependency
 * optimizer reload re-evaluates it while a request is in flight. Every copy must read
 * the env of the current request, so the store lives on `globalThis`, like
 * `authContext`. Two Void versions in one process share it: change the key when the
 * store shape changes.
 */
const ENV_CONTEXT_SYMBOL: unique symbol = Symbol.for('void.envContext.v1');
const shared = globalThis as { [ENV_CONTEXT_SYMBOL]?: AsyncLocalStorage<RuntimeEnv> };
shared[ENV_CONTEXT_SYMBOL] ??= new AsyncLocalStorage<RuntimeEnv>();
export const envContext: AsyncLocalStorage<RuntimeEnv> = shared[ENV_CONTEXT_SYMBOL];

let cloudflareEnv: RuntimeEnv | undefined;

// Synchronous detection: navigator.userAgent is "Cloudflare-Workers" in workerd
// (default since compat date 2022-03-21). Only attempt the dynamic import when
// we know we're in workerd — avoids silent .catch() on Node/Bun/Deno.
// Built-in module imports resolve before the runtime dispatches its first request,
// so cloudflareEnv is guaranteed to be set by the time any handler runs.
const isWorkerd = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

if (isWorkerd) {
  import('cloudflare:workers')
    .then((mod) => {
      cloudflareEnv = asEnv((mod as { env?: unknown }).env) ?? undefined;
    })
    .catch(() => {});
}

function asEnv(value: unknown): RuntimeEnv | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  if ('then' in value && typeof (value as { then?: unknown }).then === 'function') {
    return null;
  }
  return value as RuntimeEnv;
}

function getNuxtEnv(): RuntimeEnv | null {
  return asEnv((globalThis as RuntimeEnv & { __env__?: unknown }).__env__);
}

/** Resolve raw env from AsyncLocalStorage, Nuxt globals, or CF module env. */
export function getRawRuntimeEnv(): RuntimeEnv {
  return (
    envContext.getStore() ??
    getNuxtEnv() ??
    cloudflareEnv ??
    (() => {
      throw new Error(
        'env: Cloudflare env is unavailable. Use void runtime bindings inside Nuxt/SvelteKit/Analog server request handlers or Worker handlers.',
      );
    })()
  );
}

export { asEnv };

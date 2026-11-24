import type { CloudContext } from '../runtime/handler/index.ts';

export const DEFERRED: unique symbol = Symbol('deferred');

export type DeferredSentinel = {
  [DEFERRED]: true;
  group: string | null;
  resolver: (c: CloudContext) => Promise<unknown>;
};

/** Reactive wrapper for a deferred prop on non-React clients. */
export type DeferredState<T> =
  | { readonly loading: true; readonly value: null; readonly error: null }
  | { readonly loading: false; readonly value: T; readonly error: null }
  | { readonly loading: false; readonly value: null; readonly error: Error };

/**
 * Deferred props are represented as framework-native resources on the client.
 * React treats them as promises consumed with `use()`, while the other adapters
 * expose the historical `{ loading, value, error }` state object.
 */
export type Deferred<T> = DeferredState<T> & Promise<T>;

/** Extract the props type from a typed handler (loader). */
export type InferProps<T> = T extends { __output: infer R } ? R : never;

export function defer<T>(resolver: (c: CloudContext) => Promise<T>): Deferred<T>;
export function defer<T>(group: string, resolver: (c: CloudContext) => Promise<T>): Deferred<T>;
export function defer(
  groupOrResolver: string | ((c: CloudContext) => Promise<unknown>),
  maybeResolver?: (c: CloudContext) => Promise<unknown>,
): Deferred<unknown> {
  const [group, resolver] =
    typeof groupOrResolver === 'string'
      ? [groupOrResolver, maybeResolver!]
      : [null, groupOrResolver];
  // oxlint-disable-next-line quality/no-chained-type-assertions -- The server sends a sentinel which the client replaces with the advertised deferred resource.
  return { [DEFERRED]: true, group, resolver } as unknown as Deferred<unknown>;
}

export type ResolvedDeferredGroup = {
  resolver: (c: CloudContext) => Promise<unknown>;
  keys: Array<string>;
};

/**
 * Separate a loader's return value into immediate props and deferred sentinels.
 * For single-prop deferred (group=null), the object key becomes the group name.
 * For named groups, all keys sharing the same group name are collected.
 */
export function separateDeferred(props: Record<string, unknown>): {
  immediateProps: Record<string, unknown>;
  deferredMap: Record<string, ResolvedDeferredGroup>;
} {
  const immediateProps: Record<string, unknown> = {};
  const deferredMap: Record<string, ResolvedDeferredGroup> = {};

  for (const [key, value] of Object.entries(props)) {
    if (value && typeof value === 'object' && DEFERRED in value) {
      const sentinel = value as DeferredSentinel;
      const groupName = sentinel.group ?? key;
      if (!deferredMap[groupName]) {
        deferredMap[groupName] = { resolver: sentinel.resolver, keys: [] };
      }
      deferredMap[groupName].keys.push(key);
      // Include a loading placeholder so SSR components receive the prop
      immediateProps[key] = { value: null, loading: true, error: null };
    } else {
      immediateProps[key] = value;
    }
  }

  return { immediateProps, deferredMap };
}

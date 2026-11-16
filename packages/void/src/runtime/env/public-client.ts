/**
 * Client-side variant of `void/env`.
 *
 * Selected via the `browser` export condition. Void exposes only fixed-prefix
 * `VITE_*` schema keys to the client bundle. If a server-only key is read
 * here it isn't on `import.meta.env`, so we throw a clear error rather than
 * silently returning `undefined`.
 *
 * Schema builders (`string`, `number`, …) and `defineEnv` are re-exported
 * unchanged so that `env.ts` can be imported into any module without
 * tripping bundler errors.
 */

type ImportMetaEnvLike = {
  readonly env?: Record<string, unknown>;
};

function getClientEnv(): Record<string, unknown> | undefined {
  return (import.meta as unknown as ImportMetaEnvLike).env;
}

function readClientKey(key: string): unknown {
  const meta = getClientEnv();
  if (meta && key in meta) {
    return meta[key];
  }
  throw new Error(
    `env: Key '${key}' is not exposed to the client. ` +
      `Void only exposes VITE_* schema keys to browser code. ` +
      `Either rename the key in env.ts with that prefix, or move this access to a server module.`,
  );
}

export const env = new Proxy({} as Record<string, unknown>, {
  get(_target, key) {
    if (typeof key === 'symbol') {
      return undefined;
    }
    return readClientKey(String(key));
  },
  has(_target, key) {
    if (typeof key !== 'string') {
      return false;
    }
    const meta = getClientEnv();
    return meta ? key in meta : false;
  },
  ownKeys() {
    const meta = getClientEnv();
    return meta ? Object.keys(meta) : [];
  },
  getOwnPropertyDescriptor(_target, key) {
    if (typeof key !== 'string') {
      return undefined;
    }
    const meta = getClientEnv();
    if (!meta || !(key in meta)) {
      return undefined;
    }
    return {
      enumerable: true,
      configurable: true,
      value: meta[key],
    };
  },
}) as Record<string, unknown>;

/**
 * In client builds `defineEnv` is a no-op identity function — schema
 * registration only happens server-side. We still return the `env` proxy so
 * t3-style `export const env = defineEnv({...})` keeps working in shared
 * modules.
 */
export function defineEnv<S>(_schema: S): typeof env {
  return env;
}

export class EnvValidationError extends Error {
  constructor(
    public readonly key: string,
    public readonly issues: Array<{ message: string }>,
  ) {
    super(`Invalid env "${key}": ${issues.map((i) => i.message).join(', ')}`);
    this.name = 'EnvValidationError';
  }
}

export { string, number, boolean, url, email, oneOf, json, type EnvSchema } from './env-helpers.ts';

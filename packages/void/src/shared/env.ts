import { readdirSync } from 'node:fs';
import { join } from 'pathslash';
import { parseDotenvFile } from './dotenv.ts';

// Shared helpers for environment resolution, used by the Vite plugins,
// prerender, and the CLI. Keep these as leaf helpers — they must not
// import from any non-leaf module, otherwise the prerender subprocess's
// worker bundle acquires unwanted transitive dependencies.

/** Void's single local dotenv file. It is never a production configuration source. */
export const LOCAL_ENV_FILE = '.env';

/** The fixed browser-exposure convention supported by `void/env`. */
export const CLIENT_ENV_PREFIX = 'VITE_';

export function isClientEnvKey(key: string): boolean {
  return key.startsWith(CLIENT_ENV_PREFIX);
}

/** Read the one local-development dotenv file. */
export function loadLocalEnv(
  root: string,
  options: { onWarn?: (message: string) => void } = {},
): Record<string, string> {
  return parseDotenvFile(join(root, LOCAL_ENV_FILE), { onWarn: options.onWarn });
}

/**
 * Marks the isolated probes and Vite build run by
 * `void deploy --platform cloudflare`.
 *
 * Kept here so the deploy orchestrator and Vite plugin share one spelling.
 * The marker is passed through child-process env only; it is never a Worker
 * binding and is not set for `void dev` or ordinary `vite build` commands.
 */
export const CLOUDFLARE_DEPLOY_BUILD_ENV = 'VOID_CLOUDFLARE_DEPLOY_BUILD';

/**
 * JSON map from each `queues/` name to the Cloudflare queue name that
 * `void deploy --platform cloudflare` chose. Set only for its Vite build.
 */
export const CLOUDFLARE_QUEUE_NAMES_BUILD_ENV = 'VOID_CLOUDFLARE_QUEUE_NAMES';

/**
 * Find legacy Vite dotenv variants. Void intentionally supports only `.env`;
 * production configuration is project-scoped remote state instead of a file.
 */
export function findLegacyEnvFiles(root: string): Array<string> {
  try {
    return readdirSync(root)
      .filter(
        (name) =>
          name.startsWith('.env.') ||
          name === '.env.example' ||
          name === '.dev.vars' ||
          name.startsWith('.dev.vars.'),
      )
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Resolve whether the plugin should run in "remote" mode (proxy real
 * D1/KV/R2 via the platform) based on the project config plus an optional
 * `VOID_REMOTE` env override.
 *
 * Tri-state override semantics:
 *   - `VOID_REMOTE=1` → force remote mode on
 *   - `VOID_REMOTE=0` → force remote mode off (e.g. local/CI builds of a
 *     project whose `void.config.ts` sets `remote: true`)
 *   - unset / any other value → fall back to `config.remote`
 *
 * The dev-server plugin (index.ts), the prerender build plugin
 * (plugin-prerender.ts), and managed deploy (cli/deploy-managed-full.ts) must
 * derive `remoteMode` through this helper so dev and build stay in lockstep.
 */
export function resolveRemoteMode(configRemote: boolean | undefined): boolean {
  const override = process.env.VOID_REMOTE;
  if (override === '1') {
    return true;
  }
  if (override === '0') {
    return false;
  }
  return configRemote === true;
}

/**
 * Names starting with this prefix are reserved for Void. Void sets them
 * itself (proxy credentials, email and AI wiring), so `.env` and `env.ts`
 * must not define them: Wrangler loads `.env` into the dev Worker on its own
 * and writes it over `vars`, so dropping keys from `vars` cannot keep them
 * out. `envSchemaPlugin` and `void env check` reject them instead.
 */
export const RESERVED_ENV_PREFIX = '__VOID_';

/** Names in `keys` that use the reserved `__VOID_` prefix, in input order. */
export function findReservedEnvKeys(keys: Iterable<string>): Array<string> {
  return Array.from(keys).filter((key) => key.startsWith(RESERVED_ENV_PREFIX));
}

/**
 * The error for reserved names found in `.env` or `env.ts`. Shared by the
 * Vite plugin and `void env check` so both print the same text.
 */
export function reservedEnvKeysMessage(source: '.env' | 'env.ts', keys: Array<string>): string {
  const verb = source === '.env' ? 'defines' : 'declares';
  return (
    `${source} ${verb} names reserved for Void: ${keys.join(', ')}. ` +
    'Void sets these itself; remove them. To trigger crons or queues locally, use the ' +
    'x-void-dev-trigger header printed at dev start.'
  );
}

/**
 * Internal env keys reserved for Void runtime use. These are how the Vite
 * plugin and deploy pipeline pass credential/runtime state to workerd. None
 * of them should ever originate from user-authored `.env` files, shell env,
 * or CI config. `.env` and `env.ts` are rejected up front (see
 * `RESERVED_ENV_PREFIX`); prerender still strips these from its inputs.
 *
 * Caller: `prerender.ts` buildPrerenderBindings (CF prerender subprocess bindings).
 */
export const INTERNAL_ENV_KEYS = [
  '__VOID_ACCESS_CREDENTIALS',
  '__VOID_TOKEN',
  '__VOID_PROJECT_ID',
  '__VOID_REMOTE',
  '__VOID_STAGING',
  '__VOID_PROXY_URL',
  '__VOID_PROXY_TOKEN',
] as const;

const INTERNAL_ENV_KEY_SET: ReadonlySet<string> = new Set(INTERNAL_ENV_KEYS);

export type StripInternalEnvKeysResult<T> = {
  sanitized: T;
  stripped: Array<string>;
};

/**
 * Remove any internal Void env keys from a user-supplied env record. Returns
 * the sanitized record plus the list of keys that were stripped so callers
 * (which live in non-leaf modules) can emit a warning via `voidWarn`.
 *
 * This module is a leaf — it must not import from `../log` or any non-leaf
 * module, otherwise the prerender subprocess's worker bundle acquires
 * unwanted transitive dependencies. That's why warnings are the caller's
 * responsibility.
 */
export function stripInternalEnvKeys<T extends Record<string, unknown>>(
  input: T | undefined,
): StripInternalEnvKeysResult<T> {
  if (!input) {
    return { sanitized: {} as T, stripped: [] };
  }
  const sanitized: Record<string, unknown> = {};
  const stripped: Array<string> = [];
  for (const [key, value] of Object.entries(input)) {
    if (INTERNAL_ENV_KEY_SET.has(key)) {
      stripped.push(key);
      continue;
    }
    sanitized[key] = value;
  }
  return { sanitized: sanitized as T, stripped };
}

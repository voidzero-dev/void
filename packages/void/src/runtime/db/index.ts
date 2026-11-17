/**
 * void/db — Drizzle-powered database access.
 *
 * At build time, the Void plugin intercepts this import and serves a
 * virtual module that auto-wires the D1 binding with the user's schema.
 * This stub exists for the published npm package and type declarations.
 */
import { drizzle as _drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import {
  getRuntimeBinding,
  getRuntimeRequestResource,
  requireRuntimeBinding,
} from '../env/runtime.ts';
import { createD1SessionAccess, resolveD1SessionStart, type DbSessionStart } from './session.ts';

// Re-export commonly used Drizzle utilities so consumers never need
// to depend on drizzle-orm directly.
export {
  sql,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  desc,
  asc,
  like,
  ilike,
  notLike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  between,
  notBetween,
  exists,
  notExists,
  count,
  sum,
  avg,
  min,
  max,
} from 'drizzle-orm';
export type { AnyColumn, SQL, SQLWrapper } from 'drizzle-orm';
export type { BatchItem } from 'drizzle-orm/batch';
export type { DrizzleD1Database } from 'drizzle-orm/d1';

export type { DbSessionStart };

const DEFAULT_BINDING = 'DB';

/**
 * Create a Drizzle D1 instance from a custom D1 binding.
 * Use this when you have multiple D1 databases or need a non-default binding.
 */
export function createDb(
  d1: D1Database,
  options?: { session?: DbSessionStart },
): DrizzleD1Database {
  return _drizzle(
    d1.withSession(
      resolveD1SessionStart(
        options?.session === undefined ? 'first-unconstrained' : options.session,
        'createDb',
      ),
    ) as unknown as D1Database,
  );
}

const sessions = createD1SessionAccess(DEFAULT_BINDING);

/** Set the default D1 session's starting bookmark or constraint before using db. */
export function setSession(start: DbSessionStart): void {
  sessions.setSession(start);
}

/** Read the default request session's bookmark, or that of an explicit D1 client. */
export function getBookmark<TSchema extends Record<string, unknown>>(
  client?: DrizzleD1Database<TSchema>,
): D1SessionBookmark | null {
  return sessions.getBookmark((client as object | undefined) === db ? undefined : client);
}

const requestDbKey = {};

function requireD1(): D1Database {
  // Bundlers that skip Void's plugins load this D1 client for every app. Nitro needs the
  // `void/nitro` module to serve a PostgreSQL or MySQL app's own `void/db`. Vite serves it to
  // an installed package only when the package is an ES module that depends on void and the
  // app lists it or reaches it through such packages.
  if (
    getRuntimeBinding(DEFAULT_BINDING) == null &&
    (getRuntimeBinding('HYPERDRIVE') != null || getRuntimeBinding('DATABASE_URL') != null)
  ) {
    throw new Error(
      `db: Missing Cloudflare binding '${DEFAULT_BINDING}'. This app connects through HYPERDRIVE or DATABASE_URL, but its server bundle loaded the D1 client. In Nuxt or Analog, add 'void/nitro' to the Nitro modules. An installed package that imports void/db must be an ES module that lists void in its dependencies or peerDependencies, and the app must list it or reach it through such packages.`,
    );
  }
  return requireRuntimeBinding<D1Database>(DEFAULT_BINDING);
}

function d1Init() {
  requireD1();
  return _drizzle(sessions.getSession());
}

/**
 * Default Drizzle D1 instance — resolves the `DB` binding from the runtime
 * environment. When the Void plugin is active, this is replaced with a
 * schema-aware instance via virtual module.
 */
export const db: DrizzleD1Database = new Proxy({} as DrizzleD1Database, {
  get(_, prop) {
    // Promise assimilation and inspection are not database use.
    if (
      prop === 'then' ||
      prop === 'toJSON' ||
      prop === Symbol.toStringTag ||
      prop === Symbol.for('nodejs.util.inspect.custom')
    ) {
      return undefined;
    }
    const instance = getRuntimeRequestResource(
      requestDbKey,
      d1Init,
      // Outside Void's request scope, create an uncached client.
      d1Init,
    );
    return Reflect.get(instance, prop);
  },
});

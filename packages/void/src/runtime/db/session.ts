import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { getRuntimeRequestResource, requireRuntimeBinding } from '../env/runtime.ts';

export type DbSessionStart = D1SessionConstraint | { bookmark: D1SessionBookmark };

/** @internal Validate Void's input shape without interpreting opaque D1 bookmarks. */
export function resolveD1SessionStart(
  start: DbSessionStart,
  helper: 'setSession' | 'createDb',
): D1SessionConstraint | D1SessionBookmark {
  if (start === 'first-primary' || start === 'first-unconstrained') {
    return start;
  }
  if (typeof start === 'object' && start !== null && typeof start.bookmark === 'string') {
    return start.bookmark;
  }
  throw new Error(
    `db: ${helper}() requires 'first-primary', 'first-unconstrained', or { bookmark: string } for its session start.`,
  );
}

export interface DbRequestSession {
  start: DbSessionStart;
  session?: D1DatabaseSession;
}

export interface DbSessionAccess {
  getSession(): D1Database;
  setSession(start: DbSessionStart): void;
  getBookmark<TSchema extends Record<string, unknown>>(
    client?: DrizzleD1Database<TSchema>,
  ): D1SessionBookmark | null;
}

/** @internal Shared by the published D1 client and schema-aware generated clients. */
export function createD1SessionAccess(bindingName: string): DbSessionAccess {
  const key = {};

  function state(helper: 'setSession' | 'getBookmark'): DbRequestSession {
    return getRuntimeRequestResource(
      key,
      () => ({ start: 'first-unconstrained' }),
      () => {
        throw new Error(
          `db: ${helper}() requires Void's request scope. In framework-owned handlers, use createDb(binding, { session }) and getBookmark(client).`,
        );
      },
    );
  }

  return {
    getSession() {
      const current = getRuntimeRequestResource<DbRequestSession>(
        key,
        () => ({ start: 'first-unconstrained' }),
        // Outside Void's request scope, sessions are not shared between operations.
        // Start each session on primary to preserve fresh reads.
        () => ({ start: 'first-primary' }),
      );
      // oxlint-disable-next-line quality/no-chained-type-assertions -- Drizzle only uses the query methods shared by D1 databases and sessions.
      return (current.session ??= requireRuntimeBinding<D1Database>(bindingName).withSession(
        typeof current.start === 'object' ? current.start.bookmark : current.start,
      )) as unknown as D1Database;
    },

    setSession(start) {
      const current = state('setSession');
      const value = resolveD1SessionStart(start, 'setSession');
      // Nested middleware may have no bookmark of its own. Its fallback must
      // not discard the outer requirement, even before the first DB access.
      if (start === 'first-unconstrained') {
        return;
      }
      if (current.session) {
        // Middleware runs again on local server-side fetches. Repeated inputs
        // must preserve the existing session and any progress made by queries.
        const original = typeof current.start === 'object' ? current.start.bookmark : current.start;
        if (typeof start === typeof current.start && value === original) {
          return;
        }
        const bookmark = current.session.getBookmark();
        if (typeof start === 'object' && bookmark !== null && value <= bookmark) {
          return;
        }
        throw new Error(
          'db: setSession() cannot strengthen an opened session. Call it before the first use of db, or use createDb(binding, { session }) with getBookmark(client) for an independent session.',
        );
      }
      current.start = typeof start === 'object' ? { bookmark: value } : start;
    },

    getBookmark<TSchema extends Record<string, unknown>>(client?: DrizzleD1Database<TSchema>) {
      if (client) {
        // oxlint-disable-next-line quality/no-reflect-get -- The request-scoped client exposes $client through its get trap.
        const session = Reflect.get(client, '$client') as D1DatabaseSession | undefined;
        if (!session?.getBookmark) {
          throw new Error('db: getBookmark(client) requires a D1 session-backed client.');
        }

        return session.getBookmark();
      }
      // Inspect only: middleware on a route without database queries must not open a session.
      return state('getBookmark').session?.getBookmark() ?? null;
    },
  };
}

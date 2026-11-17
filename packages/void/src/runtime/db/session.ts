import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { getRuntimeRequestResource, requireRuntimeBinding } from '../env/runtime.ts';

export type DbSessionStart = D1SessionConstraint | (D1SessionBookmark & {});

export interface DbRequestSession {
  start: DbSessionStart;
  session?: D1DatabaseSession;
}

export interface DbSessionAccess {
  getSession(): D1Database;
  setSession(start: DbSessionStart): void;
  getBookmark<TSchema extends Record<string, unknown>>(
    client?: DrizzleD1Database<TSchema> | undefined,
  ): D1SessionBookmark | null;
}

/** @internal Shared by the published D1 client and schema-aware generated clients. */
export function createD1SessionAccess(bindingName: string): DbSessionAccess {
  const key = {};

  function state(): DbRequestSession {
    return getRuntimeRequestResource(key, () => ({ start: 'first-unconstrained' }));
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
      return (current.session ??= requireRuntimeBinding<D1Database>(bindingName).withSession(
        current.start,
      )) as unknown as D1Database;
    },

    setSession(start) {
      const current = state();
      // Nested middleware may have no bookmark of its own. Its fallback must
      // not discard the outer requirement, even before the first DB access.
      if (start === 'first-unconstrained') {
        return;
      }
      if (current.session) {
        // Middleware runs again on local server-side fetches. Repeated inputs
        // must preserve the existing session and any progress made by queries.
        if (start === current.start) {
          return;
        }
        const bookmark = current.session.getBookmark();
        if (start !== 'first-primary' && bookmark !== null && start <= bookmark) {
          return;
        }
        throw new Error(
          'db: setSession() cannot strengthen an opened session. Call it before the first use of db, or use createDb(binding, { session }) with getBookmark(client) for an independent session.',
        );
      }
      current.start = start;
    },

    getBookmark<TSchema extends Record<string, unknown>>(
      client?: DrizzleD1Database<TSchema> | undefined,
    ) {
      if (client) {
        const session = Reflect.get(client, '$client');
        if (!session?.getBookmark) {
          throw new Error('db: getBookmark(client) requires a D1 session-backed client.');
        }

        return session.getBookmark();
      }
      // Inspect only: middleware on a route without database queries must not open a session.
      return state().session?.getBookmark() ?? null;
    },
  };
}

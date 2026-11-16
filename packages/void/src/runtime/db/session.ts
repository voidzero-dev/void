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
      if (current.session) {
        throw new Error(
          'db: setSession() must be called before the first use of db in this request.',
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

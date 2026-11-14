import { getRuntimeRequestResource, requireRuntimeBinding } from './env.ts';

type SessionStart = D1SessionConstraint | D1SessionBookmark;
type RequestSession = { start: SessionStart; session?: D1DatabaseSession };

/** @internal Shared by the published D1 client and schema-aware generated clients. */
export function createD1SessionAccess(bindingName: string): {
  getSession(): D1DatabaseSession;
  setSession(start: SessionStart): void;
  getBookmark(client?: object): D1SessionBookmark | null;
} {
  const key = {};
  function state(): RequestSession {
    return getRuntimeRequestResource(key, () => ({ start: 'first-unconstrained' }));
  }
  return {
    getSession() {
      const current = getRuntimeRequestResource<RequestSession>(
        key,
        () => ({ start: 'first-unconstrained' }),
        // Preserve primary-first reads for framework handlers without Void's scope.
        () => ({ start: 'first-primary' }),
      );
      return (current.session ??= requireRuntimeBinding<D1Database>(bindingName).withSession(
        current.start,
      ));
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
    getBookmark(client) {
      if (client) {
        const session = Reflect.get(client, '$client') as D1DatabaseSession | undefined;
        if (typeof session?.getBookmark !== 'function') {
          throw new Error('db: getBookmark(client) requires a D1 session-backed client.');
        }
        return session.getBookmark();
      }
      // Inspect only: middleware on a route without database queries must not open a session.
      return state().session?.getBookmark() ?? null;
    },
  };
}

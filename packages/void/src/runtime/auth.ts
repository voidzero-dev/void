import { AsyncLocalStorage } from 'node:async_hooks';
import type { Auth, BetterAuthOptions, Session, User } from 'better-auth';
import type { Context, Env } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Filled in by the generated `.void/auth.d.ts` with the user and session types
 * Better Auth infers from the app's `auth.ts`. Empty when the app has no
 * `auth.ts`, so `AuthUser`/`AuthSession` fall back to Better Auth's base shapes.
 *
 * `AuthUser`/`AuthSession` stay type aliases (not merged interfaces) so they
 * remain assignable to `Record<string, unknown>`, and a union config (a function
 * form that returns different shapes per branch) stays a valid union type.
 */
export interface VoidAuthTypes {}

/**
 * Better Auth's inferred `{ user, session }` for an `auth.ts` default export.
 * Used by the generated `.void/auth.d.ts`; it lives here so `better-auth`
 * resolves from Void's own dependencies, not the app's.
 *
 * An `any` default export (an `auth.js` without `allowJs`, or an import that
 * does not resolve) keeps Better Auth's base shapes instead of a user type that
 * accepts any key. The tuple check also catches the error `any` of an untyped
 * import.
 */
export type InferAuthSession<T> = [unknown] extends [T]
  ? { user: User; session: Session }
  : Auth<
      Extract<T extends (...args: Array<never>) => infer R ? R : T, BetterAuthOptions>
    >['$Infer']['Session'];

export type AuthUser = VoidAuthTypes extends { user: infer U } ? U : User;
export type AuthSession = VoidAuthTypes extends { session: infer S } ? S : Session;

export type AuthState = {
  session: AuthSession;
  user: AuthUser;
};

export type VoidAuthConfigContext = {
  defaults: BetterAuthOptions;
  env: Record<string, unknown>;
  dialect: 'sqlite' | 'postgresql' | 'mysql';
  request: Request;
};

export type VoidAuthConfig =
  | BetterAuthOptions
  | ((ctx: VoidAuthConfigContext) => BetterAuthOptions);

/**
 * Shared AsyncLocalStorage that holds the authenticated Better Auth state for the
 * current request.
 *
 * Stored on `globalThis` under a `Symbol.for` key so duplicate module loads
 * (e.g. once by void's bundled runtime and once by Vite's SSR module runner
 * when user code imports from `void/auth`) share a single ALS instance. Without
 * this, the middleware writes to one instance and `getUser()` reads another,
 * always returning null.
 */
type AuthContextStore = { user: AuthUser | null; state: AuthState | null };
const AUTH_CONTEXT_SYMBOL: unique symbol = Symbol.for('void.authContext.v1');
type GlobalWithAuthContext = {
  [AUTH_CONTEXT_SYMBOL]?: AsyncLocalStorage<AuthContextStore>;
};
const globalWithAuthContext = globalThis as GlobalWithAuthContext;
export const authContext: AsyncLocalStorage<AuthContextStore> =
  globalWithAuthContext[AUTH_CONTEXT_SYMBOL] ??
  (globalWithAuthContext[AUTH_CONTEXT_SYMBOL] = new AsyncLocalStorage<AuthContextStore>());

export function defineAuth<T extends VoidAuthConfig>(config: T): T {
  return config;
}

export function getUser(): AuthUser | null {
  return authContext.getStore()?.user ?? null;
}

export function getSession(): AuthState | null {
  return authContext.getStore()?.state ?? null;
}

export function requireAuth<E extends Env & { Variables: { user: AuthUser | null } }>(
  c: Context<E>,
): AuthUser {
  const user = c.get('user');
  if (!user) {
    throw new HTTPException(401, { message: 'Unauthorized' });
  }
  return user;
}

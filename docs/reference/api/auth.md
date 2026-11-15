---
description: 'Sessions, users, and auth clients from void/auth, plus the browser helpers in void/client.'
outline: deep
---

# Authentication {#auth}

Imported from `"void/auth"`. Client-side helpers imported from `"void/client"`.

## `defineAuth(config)` {#defineauth-config}

Advanced escape hatch for customizing Void's Better Auth config.

```ts
import { defineAuth } from 'void/auth';

export default defineAuth(({ defaults }) => ({
  ...defaults,
  trustedOrigins: ['https://example.com'],
}));
```

**Signature:**

```ts
function defineAuth(config: VoidAuthConfig): VoidAuthConfig;
```

## `getUser()` {#getuser}

Returns the current authenticated user, or `null` when no user is present.

```ts
import { getUser } from 'void/auth';

const user = getUser();
```

**Signature:**

```ts
function getUser(): AuthUser | null;
```

## `getSession()` {#getsession}

Returns the current Better Auth request state, or `null`.

```ts
import { getSession } from 'void/auth';

const state = getSession();
```

**Signature:**

```ts
function getSession(): AuthState | null;
```

## `getAuth(c)` {#getauth-c}

Returns the Better Auth instance for the current request, including plugin APIs inferred from `auth.ts`. Use it with Better Auth plugin helpers or to forward requests to `auth.handler`.

```ts
import { defineHandler } from 'void';
import { getAuth } from 'void/auth';

export const GET = defineHandler((c) => getAuth(c).handler(c.req.raw));
```

Enable [authentication](../../guide/auth.md) before calling this helper; it throws if no instance is available. Anonymous requests can use it too. Call `requireAuth(c)` separately to require a signed-in user.

Cookies set by `getAuth(c).api` calls are sent with the response, so endpoints such as `signInEmail` and `signUpEmail` sign in the current browser. They are not sent on a `POST` from another origin unless it is in `trustedOrigins`. See [server usage](../../guide/auth.md#server-usage).

**Signature:**

```ts
function getAuth(c: CloudContext): AuthInstance;
```

## `requireAuth(c, options?)` {#requireauth-c}

Returns the authenticated user from the request context. Without `throwRedirect`, throws a 401 `HTTPException` if no session is present.

Use it without options in route handlers or actions when you want a plain-text `401`, not an error page:

```ts
import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

For protected pages, pass `throwRedirect` to [redirect unauthenticated visitors to login](../../guide/auth.md#protect-a-server-route):

```ts
import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const loader = defineHandler((c) => {
  const user = requireAuth(c, { throwRedirect: '/login' });
  return { email: user.email };
});
```

`throwRedirect` works in loaders, actions, and middleware. When signed out, it throws a redirect with status `302` for GET/HEAD requests or `303` for other methods, stopping execution. When signed in, it returns the user normally.

The destination is application-controlled.

**Signature:**

```ts
function requireAuth(c: CloudContext, options?: { throwRedirect?: string }): AuthUser;
```

## `AuthUser` {#authuser}

Better Auth user shape re-exported by Void. It also includes the fields that Better Auth plugins and `user.additionalFields` in `auth.ts` add, for example `role` from `admin()` or a custom `plan` field. Your tsconfig needs the generated Void types for this; see [Type Safety setup](../../guide/type-safety.md#setup).

```ts
interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## `AuthSession` {#authsession}

Better Auth session shape re-exported by Void. It also includes the session fields that Better Auth plugins in `auth.ts` add, for example `impersonatedBy` from `admin()`.

```ts
interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}
```

::: tip Types inside `auth.ts`
In `auth.ts` and its imports, let Better Auth infer hook types or use its `User` and `Session` types. Using Void's inferred auth types or auth helper results there creates a circular reference. Callbacks such as `sendResetPassword` receive Better Auth's base `User` type.
:::

## `AuthState` {#authstate}

Combined authenticated request state:

```ts
interface AuthState {
  user: AuthUser;
  session: AuthSession;
}
```

## `auth` {#auth-1}

Imported from `"void/client"`. This is a ready-to-use Better Auth client instance preconfigured with `basePath: "/api/auth"`.

```ts
import { auth } from 'void/client';

await auth.signIn.email({ email, password });
await auth.signOut();
```

The exact client methods come from Better Auth. In pages apps, Void automatically chooses the framework-specific Better Auth client package when available.

For regular SPA apps that use Void for API/file routes without Void Pages mode, import the framework-specific client explicitly:

```ts
import { auth } from 'void/client/react';
// or: 'void/client/vue'
// or: 'void/client/svelte'
// or: 'void/client/solid'
```

Those subpaths keep the same `fetch`, `fetchStream`, and auth exports as `void/client`, but bind `auth` and `createAuthClient` to Better Auth's framework package.

## `createAuthClient` {#createauthclient}

Imported from `"void/client"`. Re-export of Better Auth's `createAuthClient` for advanced usage.

```ts
import { createAuthClient } from 'void/client';

const auth = createAuthClient({ basePath: '/api/auth' });
```

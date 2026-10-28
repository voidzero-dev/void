---
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

## `requireAuth(c)` {#requireauth-c}

Extracts the authenticated user from the request context. Throws a 401 `HTTPException` if no session is present.

```ts
import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

**Signature:**

```ts
function requireAuth(c: CloudContext): AuthUser;
```

## `AuthUser` {#authuser}

Better Auth user shape re-exported by Void.

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

Better Auth session shape re-exported by Void.

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

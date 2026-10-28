---
outline: deep
---

# Authentication

::: warning ⚠️ Void Apps Only
Void-managed auth requires a native Void app on Cloudflare. For meta-frameworks or Node.js, Bun, and Deno, use Better Auth directly.
:::

Void configures [Better Auth](https://www.better-auth.com/) for your app, including its database connection, API routes, and client. Start with email and password, or add a social login provider.

## Quick Start

### 1. Enable auth

Import `auth` from `void/client` to enable email/password auth automatically. Use [configuration](#config) to add social providers.

### 2. Sign up and sign in

Use the preconfigured auth client from `void/client`:

```tsx
import { auth } from 'void/client';

// sign up
await auth.signUp.email({
  email: 'alice@example.com',
  password: 'example-password-123',
  name: 'Alice',
});

// sign in
await auth.signIn.email({
  email: 'alice@example.com',
  password: 'example-password-123',
});
```

### 3. Protect a server route

Call `requireAuth` in a route handler or page loader that needs a signed-in user. It returns that user, or throws `401` if the request isn't authenticated:

```ts
// routes/api/profile.ts
import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { email: user.email };
});
```

In a pages-mode loader, use `getUser` or `getSession` when you want to allow unauthenticated access:

```ts
// pages/dashboard.server.ts
import { defineHandler, type InferProps } from 'void';
import { getUser } from 'void/auth';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  const user = getUser();
  return { user };
});
```

### 4. Sign out

```tsx
await auth.signOut();
```

## Config

Auth turns on automatically when you:

- import anything from `void/auth`
- import `auth` from `void/client`
- add `auth` to `void.config.ts`
- add a root-level `auth.ts` file

Email/password is enabled by default. To add social providers:

```json
{
  "auth": {
    "providers": ["email", "google", "github"]
  }
}
```

Provider credentials come from `AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET`. `cognito` also needs a domain, region, and user pool ID: set `AUTH_COGNITO_DOMAIN`, `AUTH_COGNITO_REGION`, and `AUTH_COGNITO_USER_POOL_ID`, or set them in `auth.ts`.

See the full provider list in the [config reference](../reference/config.md#auth).

For example, `github` uses:

- `AUTH_GITHUB_CLIENT_ID`
- `AUTH_GITHUB_CLIENT_SECRET`

## Client Usage

The `auth` client uses [Better Auth's client API](https://www.better-auth.com/docs/concepts/client) at `/api/auth`. Void selects the client for your framework automatically.

For a custom client, import `createAuthClient` from `void/client`.

## Server Usage

`void/auth` provides the server-side helpers:

```ts
import { getSession, getUser, requireAuth } from 'void/auth';
```

- `getUser()` returns the current `AuthUser | null`
- `getSession()` returns `{ user, session } | null`
- `requireAuth(c)` returns the authenticated user or throws `401`

Import `AuthUser` and `AuthSession` from `void/auth` for type annotations. See their fields in the [API reference](../reference/api/auth.md#authuser).

## Behavior

Auth sessions use the same database as your app. Void creates `BETTER_AUTH_SECRET` on deploy if it is missing and reuses it on later deploys.

Local development needs no secret setup. To preview a production build locally, provide `BETTER_AUTH_SECRET`.

Responses to signed-in requests get `Cache-Control: no-store`, so neither the browser cache nor a shared cache keeps a user's data. A route keeps its own policy when it sets `no-store`, or `private` together with `no-cache`. To answer repeat requests with `304`, use `private, no-cache` with Hono's [`etag()`](https://hono.dev/docs/middleware/builtin/etag) middleware. If you set the `ETag` yourself, make it differ per user, so the `304` doesn't reuse another account's page. The browser cache keeps a copy of a `private, no-cache` page, so the Back button can show it again after the user signs out. Keep the default `no-store` for pages that must not stay in the browser cache.

Static files from your build and `public/` keep their own cache policy for signed-in requests, so the browser reuses cached JavaScript and CSS. When your app handles the request, the policy is marked `private`, and a request that refreshes the session cookie gets `no-store`.

`POST`, `PUT`, `PATCH` and `DELETE` requests and WebSocket connections from another origin don't use the signed-in session unless that origin is in `trustedOrigins`. If a separate frontend calls your app, add its origin there (see [Customization](#customization)). If your routes use their own cookies, check the request `Origin` yourself, for example with Hono's [`csrf()`](https://hono.dev/docs/middleware/builtin/csrf) middleware.

Deployed apps on Cloudflare limit auth requests per client IP with Better Auth's defaults, for example 3 sign-in attempts per 10 seconds. Each Worker instance keeps its own count. Change or turn off the limits with `rateLimit` in `auth.ts`. To share one count across instances, set `rateLimit: { storage: 'database' }`, then run `void db generate` for a direct Cloudflare deploy.

### Proxies and end-to-end tests

All requests from one IP share one count. Two common setups reach the limits:

- A server calls your auth endpoints for your users, such as a backend-for-frontend, a rewrite from Vercel or nginx, or another Worker's `fetch`. All of those users share that server's IP.
- End-to-end tests sign up or sign in many times against a deployed app.

Don't read the client IP from `x-forwarded-for` instead: any client can send that header. Give the trusted caller a secret header, and skip the limits only for requests that carry it:

```ts
import { defineAuth } from 'void/auth';

export default defineAuth(({ defaults, env }) => ({
  ...defaults,
  rateLimit: {
    customRules: {
      '/**': (request, rule) =>
        env.AUTH_TRUSTED_KEY && request.headers.get('x-auth-trusted-key') === env.AUTH_TRUSTED_KEY
          ? false
          : rule,
    },
  },
}));
```

`'/**'` matches every auth endpoint. Returning `false` skips the limit, and returning `rule` keeps the default limit for everyone else. Declare `AUTH_TRUSTED_KEY: string().optional()` in `env.ts` and set it with `void secret put AUTH_TRUSTED_KEY` (see [Environment variables](./env-vars.md#production-server-values)).

Your app no longer limits requests that carry the key, so:

- A proxy that sends it must limit every auth request it forwards for each of its users, including sign-up, password reset and verification emails.
- A test runner should send it only to your app. Never put the key in code that runs in your users' browsers.

## Customization

For advanced configuration, create `auth.ts` at the project root and export `defineAuth(...)`:

```ts
import { defineAuth } from 'void/auth';

export default defineAuth(({ defaults }) => ({
  ...defaults,
  trustedOrigins: ['https://example.com'],
}));
```

`defaults` already includes Void's conventions. Extend it explicitly instead of expecting a deep merge.

For the full set of available options, see the official [Better Auth options reference](https://www.better-auth.com/docs/reference/options).

## Database and Migrations

Auth tables live alongside your app's tables. During local development, Void creates them automatically. While the dev server runs, saving `auth.ts`, or a local file it imports, updates the auth schema Void generates for your app. New auth tables and columns are created in the local database the next time the dev server starts.

Void platforms create auth tables automatically. For a direct Cloudflare deploy, include them in your checked-in migrations:

```sh
void db generate
```

Review and commit the SQL before deploying. Void includes your auth configuration and plugin tables; you don't need to duplicate them in `db/schema.ts` or run the Better Auth CLI.

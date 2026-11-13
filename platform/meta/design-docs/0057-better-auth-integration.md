---
title: Better Auth Integration
status: implemented
---

# Better Auth integration

Void apps use Better Auth for managed authentication. Auth activates from configuration or auth imports, mounts its route at /api/auth, and exposes the preconfigured client through void/client. Server helpers are available from void/auth; defineAuth() provides advanced configuration. Meta-framework mode is outside this integration.

Void supports the app's D1, PostgreSQL, or MySQL database through its generated auth schema and Drizzle adapter. Auth-enabled deployments require BETTER_AUTH_SECRET, which the platform stores as a project secret. This replaces the earlier bespoke session and identity implementation.

Void generates tables and an adapter into `.void/better-auth-schema.ts` and
`.void/better-auth-db.ts`. The adapter uses the app's `void/db` connection with
Better Auth's Drizzle adapter, and the auth route reuses the auth instance
prepared for its request.

The generated tables also drive auth migration checks. Auth schema changes
share the application's deployment migration workflow instead of running
request-time migrations. See [auth code generation](../../../packages/void/src/auth/drizzle.ts)
and [plugin integration](../../../packages/void/src/plugin-routing.ts).

The framework implementation lives in [auth source](../../../packages/void/src/auth) and [runtime integration](../../../packages/void/src/runtime/better-auth-shared.ts). See the [authentication guide](../../../docs/guide/auth.md) for the supported API and setup.

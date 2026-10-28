---
title: Better Auth Integration
status: implemented
---

# Better Auth integration

Void apps use Better Auth for managed authentication. Auth activates from configuration or auth imports, mounts its route at /api/auth, and exposes the preconfigured client through void/client. Server helpers are available from void/auth; defineAuth() provides advanced configuration. Meta-framework mode is outside this integration.

Void supports the app's D1, PostgreSQL, or MySQL database through its generated auth schema and Drizzle adapter. Auth-enabled deployments require BETTER_AUTH_SECRET, which the platform stores as a project secret. This replaces the earlier bespoke session and identity implementation.

The framework implementation lives in [auth source](../../../packages/void/src/auth) and [runtime integration](../../../packages/void/src/runtime/better-auth-shared.ts). See the [authentication guide](../../../docs/en/guide/auth.md) for the supported API and setup.

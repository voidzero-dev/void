---
title: Drizzle-Native Better Auth Integration
status: implemented
---

# Drizzle-native Better Auth integration

Void generates Better Auth tables and a database adapter into .void/better-auth-schema.ts and .void/better-auth-db.ts. The adapter uses the app's void/db connection with Better Auth's Drizzle adapter, so D1, PostgreSQL, and MySQL auth traffic share Void's database path. The auth route reuses the auth instance prepared for its request.

Generated auth tables also form the basis of Void's auth migration checks. This keeps auth schema changes in the same deployment workflow as application database changes rather than running a separate request-time migration path.

See [auth code generation](../../../packages/void/src/auth/drizzle.ts), [plugin integration](../../../packages/void/src/plugin-routing.ts), and the [authentication guide](../../../docs/en/guide/auth.md).

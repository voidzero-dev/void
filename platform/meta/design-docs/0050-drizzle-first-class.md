---
title: First-Class Drizzle Database Integration
status: implemented
---

# First-class Drizzle database integration

Void uses Drizzle as the application database abstraction. The app defines
its schema in TypeScript, and void/db exposes an environment-bound Drizzle
instance plus createDb for another compatible binding. This replaced the
earlier custom query client and generated SQL-table types.

The CLI supports schema-driven local prototyping and migration workflows;
deployment applies committed migrations against the configured application
database. D1 remains the default Cloudflare database, while supported
PostgreSQL and MySQL paths use their own bindings and drivers. See the
[database guide](../../../docs/en/guide/database.md) for the current commands
and dialect-specific requirements.

---
title: Platform Metadata in PostgreSQL
status: implemented
---

# Platform metadata in PostgreSQL

The platform stores users, projects, deployments, and operational state in a
dedicated PostgreSQL database reached from Workers through Hyperdrive.
Application databases are separate: a project can still use D1, PostgreSQL,
or another supported app database.

The platform uses Drizzle's PostgreSQL schema and node-postgres driver. The
installer accepts an existing PostgreSQL connection URL, creates platform
tables and a Hyperdrive configuration, and retains the database outside the
Cloudflare resource lifecycle. The installation is provider-neutral; it does
not create or require a PlanetScale account. This replaced the original D1
platform metadata store while leaving application D1 provisioning independent.

See the [self-hosted installation guide](../../../docs/en/guide/self-hosted-platform.md)
for the maintained database requirements and recovery boundary.

---
title: Managed Build Service
status: implemented
---

# Managed build service

A GitHub connection can start a managed deployment from a push. The platform has two executors: a Cloudflare Container build, scheduled by BuildScheduler and owned by a per-build BuildManager Durable Object, or a GitHub Actions workflow authenticated through GitHub OIDC. Both invoke the real void deploy CLI with a short-lived project-scoped token. They use the same deployment validation and upload path as a local deploy; there is no separate build-artifact endpoint.

PostgreSQL owns authoritative build status and GitHub connection settings. Container builds retain logs through BuildManager and expose status, cancellation, and logs through the API and administrator UI. The OIDC path pins the workflow path on the connection, so an unapproved workflow cannot mint a deploy token. Managed builds are optional platform components.

See [build scheduling](../../packages/api/src/build-scheduler.ts), [build management](../../packages/api/src/build-manager.ts), [OIDC exchange](../../packages/api/src/routes/auth-oidc.ts), and the [GitHub deployment guide](../../../docs/en/guide/deployment.md). [Implementation decisions](./0011-builds-implementation-plan.md) record the durable details.

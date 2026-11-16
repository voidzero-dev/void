---
title: Managed Build Service
status: implemented
---

# Managed build service

A GitHub connection can start a managed deployment from a push. The platform has two executors: a Cloudflare Container build, scheduled by BuildScheduler and owned by a per-build BuildManager Durable Object, or a GitHub Actions workflow authenticated through GitHub OIDC. Both invoke the real void deploy CLI with a short-lived project-scoped token. They use the same deployment validation and upload path as a local deploy; there is no separate build-artifact endpoint.

PostgreSQL owns authoritative build status and GitHub connection settings. Container builds retain logs through BuildManager and expose status, cancellation, and logs through the API and administrator UI. The OIDC path pins the workflow path on the connection, so an unapproved workflow cannot mint a deploy token. Managed builds are optional platform components.

See [build scheduling](../../packages/api/src/build-scheduler.ts), [build management](../../packages/api/src/build-manager.ts), [OIDC exchange](../../packages/api/src/routes/auth-oidc.ts), and the [GitHub deployment guide](../../../docs/guide/deployment.md).

Container size is persisted with each build; cancellation and cleanup address
the same Durable Object class that started it. Check runs and log presentation
must agree with PostgreSQL status across concurrent cancellation and completion.

See the [API guide](../../packages/api/README.md#deploy-on-github),
[GitHub identity design](./0074-github-deploy-identity-linking.md),
[check-run decisions](./0075-compare-failure-logging-github-check-runs.md), and
[build-log decisions](./0076-build-logs.md) for the detailed contracts.

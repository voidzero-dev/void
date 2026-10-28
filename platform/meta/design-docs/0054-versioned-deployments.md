---
title: Versioned Deployments
status: implemented
---

# Versioned deployments

Worker-backed platform deployments upload a separate script for each deployment. The candidate receives its bindings and deploy-time migrations before routing changes. Only a validated candidate becomes the active deployment. A failed candidate leaves the prior live deployment available, and retained scripts support rollback.

The platform tracks the active deployment and retention state in PostgreSQL while routing entries point to the selected script. Queue and cron cutovers follow the same deployment lifecycle. Migration execution uses the [stable protocol](./0072-migration-runner-stability.md); cutover recovery is recorded in the [queue design](./0062-transactional-queue-setup.md).

See [deployment orchestration](../../../platform/packages/api/src/routes/deploy.ts), [deployment guide](../../../docs/en/guide/deployment.md), and [platform architecture](../architecture.md).

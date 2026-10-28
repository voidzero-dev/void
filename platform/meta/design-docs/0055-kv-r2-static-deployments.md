---
title: KV/R2 Static Deployments
status: implemented
---

# KV/R2 static deployments

Static and SPA platform deployments do not need a per-deployment tenant Worker. The CLI uploads changed asset bytes directly to project-scoped R2 objects, and the API stores a deployment serving manifest. Dispatch resolves the active static deployment from routing, applies asset and SPA handling rules, and serves bytes from the platform's KV or R2 stores.

Static deployments retain their manifests for rollback. Eviction removes only assets no longer referenced by retained or active deployments. See [direct upload design](./0068-direct-r2-asset-upload.md), [deployment handling](../../../platform/packages/api/src/routes/deploy.ts), [dispatch](../../../platform/packages/dispatch/src/index.ts), and the [static assets guide](../../../docs/en/guide/edge/static-assets.md).

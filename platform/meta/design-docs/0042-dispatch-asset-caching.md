---
title: Dispatch-Level Asset Caching
status: implemented
---

# Dispatch-level asset caching

Dispatch caches content-hashed static assets before invoking the tenant Worker. Eligible GET requests under the configured hashed asset prefix use a shared cache key because their URLs change with content. On a miss, dispatch obtains the asset and stores an immutable response. Non-hashed and dynamic paths follow their normal routing and cache rules.

The same edge layer caches successful mirrored responses when the Workers for Platforms asset fallback serves a missing Cloudflare asset. See [dispatch caching](../../../platform/packages/dispatch/src/index.ts), [asset fallback](./0066-wfp-asset-r2-fallback.md), and the [static assets guide](../../../docs/en/guide/edge/static-assets.md).

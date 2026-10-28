---
title: Deploy-Time Prerendering
status: implemented
---

# Deploy-time prerendering

A page can export prerender = true, with getPrerenderPaths() for dynamic routes. During a platform deployment, Void invokes the candidate Worker for those paths and stores the rendered output in its deployment-scoped ISR cache before switching traffic. A positive revalidation TTL is required; disabling ISR also disables this deployment phase.

This warms selected paths so the first visitor after cutover does not pay for a cold render. See [prerender discovery](../../../packages/void/src/prerender.ts), [deployment handling](../../../platform/packages/api/src/routes/deploy.ts), and the [prerendering guide](../../../docs/en/guide/edge/prerendering.md).

---
title: Direct Cloudflare Deployment
status: implemented
---

# Direct Cloudflare deployment

void deploy --platform cloudflare builds and uploads an app into the developer's Cloudflare account. The framework emits a standard Worker and infers required bindings from app usage. The CLI resolves and provisions the selected account's resources, checks deployment prerequisites, and uses Cloudflare's native upload path. Apps can also maintain Wrangler configuration for their own bindings.

This path does not depend on the self-hosted platform's API, dispatch namespace, or PostgreSQL control plane. See [native deployment implementation](../../../packages/void/src/cli/deploy.ts) and the [deployment guide](../../../docs/en/guide/deployment.md).

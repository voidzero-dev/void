---
title: Multi-Provider AI
status: implemented
---

# Multi-provider AI

Void exposes two third-party model paths through void/ai. ai.run() accepts Cloudflare AI Gateway model identifiers and Cloudflare-compatible input schemas. ai.provider(provider).fetch(path, init) sends a provider-native request through AI Gateway, using the app's provider key from a project secret. The latter preserves the provider's native request and response shape.

On a direct deployment, requests use the app's configured AI Gateway. On a platform deployment, requests pass through the installation proxy and its project controls. Neither path grants a tenant the platform's AI credential. See the [AI runtime](../../../packages/void/src/runtime/ai.ts), [proxy route](../../../platform/packages/proxy/src/ai.ts), and [AI guide](../../../docs/en/guide/ai.md).

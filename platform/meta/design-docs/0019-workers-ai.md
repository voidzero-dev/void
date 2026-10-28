---
title: Workers AI
status: implemented
---

# Workers AI

Importing void/ai enables Void's typed AI runtime and inferred binding. ai.run() follows Cloudflare's model and input types; ai.stream() wraps streaming inference in an SSE response. Direct Cloudflare deployments use the app owner's AI binding and allowance. Platform deployments route inference through the platform proxy so tenant Workers do not receive the platform account's AI binding directly.

The proxy applies the installation's project identity and usage controls before forwarding to Cloudflare AI Gateway. The same proxy also serves other remote bindings, so AI does not have its own Worker. See the [AI runtime](../../../packages/void/src/runtime/ai.ts), [proxy route](../../../platform/packages/proxy/src/ai.ts), and [AI guide](../../../docs/en/guide/ai.md).

---
title: URL Rewrites
status: implemented
---

# URL rewrites

Void distinguishes forced rewrites from fallback rewrites. A forced rewrite runs before asset resolution and Worker dispatch; a fallback rewrite runs after a static miss or a Worker 404. Both serve another internal path while retaining the browser URL. Redirects return a 3xx response instead. The deploy manifest carries pre-asset redirectRules and post-resolution fallbackRules so dispatch applies the same phase ordering as the framework.

Rules can come from routing configuration or _redirects. The runtime preserves the original URL for handlers and includes rewrite identity in ISR cache variants. A bounded traversal prevents rewrite loops. See [dispatch routing](../../../platform/packages/dispatch/src/index.ts), [framework routing](../../../packages/void/src/asset-routing.ts), and the [rewrites guide](../../../docs/en/guide/edge/rewrites.md).

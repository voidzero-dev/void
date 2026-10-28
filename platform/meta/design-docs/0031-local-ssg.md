---
title: Local Static Output
status: implemented
---

# Local static output

Setting output to static makes the build prerender pages with known paths
into HTML assets. A page can opt out when it must render on request. Build
output can therefore be fully static or a mix of assets and server routes.

The deployment path inspects the result rather than requiring the user to
declare a separate app type. When every page is prerendered and no backend
feature remains, the result can deploy as assets without a Worker. This
build-time output is separate from deploy-time ISR prerendering and remains
available when ISR caching is disabled.

See the [static output guide](../../../docs/en/guide/ssg.md) for page overrides
and deployment behavior.

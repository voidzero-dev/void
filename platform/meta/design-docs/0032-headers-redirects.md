---
title: Headers and Redirects
status: implemented
---

# Headers and redirects

Void accepts response-header and redirect rules from void.json and the
corresponding _headers and _redirects files. The framework parses and merges
them into the deploy routing contract, and local development applies the
same rule set. Routing rules run in order with the first match taking effect;
header rules merge matching declarations with later values overriding the
same header name.

Redirects and status-200 rewrites use distinct routing phases around asset
resolution. The source representation is shared across development,
packaging, and dispatch so a deployed rule does not silently change
meaning. See the [headers guide](../../../docs/en/guide/edge/headers.md) and
[redirects guide](../../../docs/en/guide/edge/redirects.md).

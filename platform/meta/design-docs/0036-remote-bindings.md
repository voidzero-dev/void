---
title: Remote Bindings in Development
status: implemented
---

# Remote bindings in development

A project can opt into remote development so local code uses the linked
platform project's D1, KV, and R2 resources through an authenticated proxy.
The local runtime replaces those bindings with proxy-backed implementations;
the platform chooses the resource from the project's deployed configuration.
The developer's platform session authorizes the proxy request.

Operations whose semantics cannot be preserved by the proxy fail explicitly.
For example, D1 batch is sent to the deployed native handler rather than
split into independent REST statements. Native Cloudflare development uses
Cloudflare's remote binding support for its own destination. See the
[remote development guide](../../../docs/en/guide/remote-dev.md).

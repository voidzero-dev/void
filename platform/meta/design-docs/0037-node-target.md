---
title: Node.js Deploy Target
status: implemented
---

# Node.js deploy target

The Node target builds a server entry that runs Void routes, middleware,
Pages rendering, and static-asset handling in a Node.js process. It shares
the routing and application APIs with the Worker target where the runtime
supports them, while Cloudflare-only bindings and provisioning stay with
Cloudflare deployment.

Cron handlers can compile into the Node output, but an external scheduler
must invoke them. This keeps the target portable and avoids hiding a process
scheduler inside the framework. See the
[Node.js, Bun, and Deno guide](../../../docs/en/integrations/nodejs-bun-deno.md)
for current target support and limitations.

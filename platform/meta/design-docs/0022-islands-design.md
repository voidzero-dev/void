---
title: Islands Mode
status: implemented
---

# Islands mode

Islands pages use the Pages routing, loader, action, middleware, layout, and
caching pipeline. Their distinguishing behavior is selective hydration:
components render on the server by default, while import attributes mark the
components that need a client entry and a hydration strategy. The build emits
client code for those islands instead of hydrating the entire page.

The framework adapters render the server page and supply their own island
hydration runtime. This keeps the server contract shared while allowing React,
Vue, Svelte, and Solid to retain their rendering semantics. Layouts still
wrap the server render; hydration is attached to selected components.

See the [islands guide](../../../docs/en/guide/pages-routing/islands.md) for
supported file conventions, directives, and framework behavior.

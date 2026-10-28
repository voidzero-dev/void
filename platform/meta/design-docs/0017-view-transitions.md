---
title: Pages View Transitions
status: implemented
---

# Pages view transitions

Pages adapters can opt into the browser View Transition API for client navigation. The shared navigation engine wraps the page update when the feature is enabled and supported; unsupported browsers update normally. Adapter configuration supplies the default, and a Link or programmatic visit can override it for one navigation. Back and forward visits use the same navigation path.

See the [navigation engine](../../../packages/void/src/pages/navigation-engine.ts) and [view transitions guide](../../../docs/en/guide/pages-routing/view-transitions.md).

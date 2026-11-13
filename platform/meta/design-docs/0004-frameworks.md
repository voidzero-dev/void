---
title: Meta-Framework Integration
status: implemented
---

# Meta-framework integration

Void detects supported meta-frameworks from project dependencies and lets each framework own routing and its Worker entry. Void still supplies binding inference, database and migration support, build integration, and deployment. The supported framework set and setup are maintained in the [framework overview](../../../docs/integrations/frameworks/overview.md).

Vite-plugin frameworks integrate with `voidPlugin()`; frameworks with their own
adapter or CLI use Void's deployment presets, inference and runtime helpers at
the depth their build permits. Dependency detection selects the framework and
preset, while explicit binding configuration remains available.

The [deployment presets](../../../packages/void/src/cli/preset.ts),
[framework detector](../../../packages/void/src/plugin-inference.ts) and [plugin composition](../../../packages/void/src/index.ts) implement this split. Solid's Void Pages adapter is separate from SolidStart meta-framework detection; no SolidStart support is claimed here.

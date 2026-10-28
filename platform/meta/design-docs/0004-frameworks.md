---
title: Meta-Framework Integration
status: implemented
---

# Meta-framework integration

Void detects supported meta-frameworks from project dependencies and lets each framework own routing and its Worker entry. Void still supplies binding inference, database and migration support, build integration, and deployment. The supported framework set and setup are maintained in the [framework overview](../../../docs/en/integrations/frameworks/overview.md).

The [framework detector](../../../packages/void/src/plugin-inference.ts) and [plugin composition](../../../packages/void/src/index.ts) implement this split. Solid's Void Pages adapter is separate from SolidStart meta-framework detection; no SolidStart support is claimed here.

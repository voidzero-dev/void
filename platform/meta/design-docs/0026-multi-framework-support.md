---
title: Multi-Framework Support
status: implemented
---

# Multi-framework support

Void groups supported meta-frameworks by how they build a Cloudflare Worker. Vite-plugin frameworks integrate with voidPlugin(), while frameworks with their own adapter or CLI use Void's deployment preset, binding inference, runtime helpers, and deployment path at the depth their build permits. Dependency detection selects the framework and preset; explicit binding configuration remains available.

The supported integrations and their limits are in the [framework overview](../../../docs/en/integrations/frameworks/overview.md). See [framework inference](../../../packages/void/src/plugin-inference.ts), [deployment presets](../../../packages/void/src/cli/preset.ts), and [plugin composition](../../../packages/void/src/index.ts).

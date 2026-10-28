---
title: Typed Page Forms
status: implemented
---

# Typed page forms

Void generates a PageActionMap from page actions and their validators. Adapter useForm helpers use that map to type action URLs, form bodies, parameters, and validation errors. Actions without validators still appear as addressable URLs, while named actions have their own inferred body types.

The generated map is in [route code generation](../../../packages/void/src/codegen/route-types.ts). React, Vue, Svelte, and Solid provide their own useForm runtime. The [actions and forms guide](../../../docs/en/guide/pages-routing/actions-and-forms.md) defines the public behavior.

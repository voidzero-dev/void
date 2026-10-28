---
title: Typed File-Based API Routes
status: implemented
---

# Typed file-based API routes

Void compiles route files into a Hono runtime and generates route types in .void/routes.d.ts. Handlers and Standard Schema validators define method inputs and outputs; void/client consumes the generated map for typed fetch calls. Generated type references point at the handler modules, avoiding a single inferred Hono app type that grows with every route.

Body, query, and route params are separate validator slots. Client output types reflect JSON serialization. See [route code generation](../../../packages/void/src/codegen/route-types.ts), [routing plugin](../../../packages/void/src/plugin-routing.ts), and the [server routing guide](../../../docs/en/guide/server-routing.md).

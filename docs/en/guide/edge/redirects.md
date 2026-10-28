---
outline: deep
---

# Redirects

Define URL redirects in [`void.config.ts`](../../reference/config) using the `routing.redirects` field. Keys are source URL patterns, values are destination strings or objects with an explicit status.

```json
{
  "routing": {
    "redirects": {
      "/old": "/new",
      "/blog/*": { "to": "/posts/:splat", "status": 301 }
    }
  }
}
```

## Rules

- **Source patterns** start with `/`. `*` matches any characters including `/`.
- **Destinations** can be strings (default `302`) or objects with `to` and optional `status`. Supported statuses: `301`, `302`, `303`, `307`, `308`.
- `:splat` in the destination is replaced with the portion of the path matched by `*` in the source pattern.
- Destination query strings are merged into the `Location` header (the destination's parameters take precedence on per-key conflict). To drop the incoming query, write an explicit reset like `?`.
- When multiple rules match, the **first match wins**. Put specific patterns before catch-all patterns.
- Redirects are evaluated **before** the request reaches the worker, so they short-circuit static asset serving, ISR, and SSR.

## Domain-level redirects

Prefix a source with `https://host` to redirect only requests to that domain:

```json
{
  "routing": {
    "redirects": {
      "https://www.example.com/*": "https://example.com/:splat",
      "https://old-marketing.com/*": "https://example.com/:splat"
    }
  }
}
```

The `_redirects` file accepts the same syntax:

```
https://www.example.com/*  https://example.com/:splat  301
```

Path-only sources apply to every domain on the project. Host-prefixed sources apply only to the named domain.

The source must use `https://` and a literal hostname without wildcards or a port. Add the domain to your project with `void domain add` before deploying the rule. A domain awaiting certificate verification starts redirecting once it becomes active.

## Framework `_redirects` files

Void reads `_redirects` files produced by supported frameworks. You can also place one in Vite's `publicDir`:

```text
/old-page  /new-page     301
/blog/*    /posts/:splat 301
```

Rules in `void.config.ts` take precedence over file rules. Use `200` for a fallback or `200!` for a [rewrite](./rewrites#redirects-file). Redirects don't need the `!` suffix.

---
description: 'Set custom response headers from void.config.ts. Match URL patterns to header names and values.'
outline: deep
---

# Custom Headers

Define custom response headers in [`void.config.ts`](../../reference/config) using the `routing.headers` field. Keys are URL patterns, values are arrays of `"Name: value"` strings.

```json
{
  "routing": {
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"],
      "/*.html": ["Cache-Control: no-cache"]
    }
  }
}
```

## Rules

- **Pattern keys** start with `/`. `*` matches any characters including `/`.
- **Header values** use `Name: value` format. The value may contain colons.
- All matching rules are merged. When multiple rules set the same header name, the **last match wins**.
- User-defined `Cache-Control` overrides the built-in default. The default still applies when no rule matches.
- With [authentication](../auth.md), responses to requests with cookies or credentials stay private, and auth endpoints stay uncached, in development, on direct Cloudflare deployments, and on [other runtimes](../deployment.md#other-runtimes). On a [Void platform](../deployment.md#deploy-to-a-team-platform), header rules can replace those cache settings. Keep public cache rules away from signed-in pages and `/api/auth/*`.
- Rules also apply to errors, including 404s. Use immutable caching only for URLs that change with their content, so a missing file isn't cached under a permanent URL.

## Scope

Header rules apply to static assets, SSR pages, and API responses, including hashed assets served from cache.

For hashed assets, you can add headers, but the platform keeps control of caching and response encoding. Rules cannot replace `Cache-Control`, `Content-Type`, `Content-Encoding`, `Content-Length`, `Content-Range`, `Accept-Ranges`, or `Transfer-Encoding` on these files.

Header rules do not apply to ISR cache responses.

### Cookie headers

On a [Void platform](../deployment.md#deploy-to-a-team-platform), set cookies in your app's response. Header rules ignore `Set-Cookie`, remove `"cookies"` from `Clear-Site-Data`, and ignore `Clear-Site-Data` rules containing `"*"`. You can use directives such as `"cache"` and `"storage"` in header rules.

These limits apply on all of your app's hostnames, including custom domains, to protect cookies for other apps on the shared domain. Your app's own cookie headers can still affect those apps, so scope cookies carefully. See [Domains and Resources](../platform/installation/domains.md#adding-a-domain).

During local development, with `void deploy --platform cloudflare`, and on [other runtimes](../deployment.md#other-runtimes), header rules apply both headers as written.

## Framework `_headers` files

On a Void platform, Void reads `_headers` files produced by supported frameworks. Your `routing.headers` rules run afterward, so they can override framework defaults.

For direct Cloudflare framework deployments, put `_headers` in your framework's public asset directory. Its rules apply to static files, including when a deployment preserves existing secrets. To set headers on Worker responses, use your framework's server code.

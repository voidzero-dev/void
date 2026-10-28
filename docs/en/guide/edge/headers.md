---
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

## Scope

Header rules apply to static assets, SSR pages, and API responses, including hashed assets served from cache.

For hashed assets, you can add headers, but the platform keeps control of caching and response encoding. Rules cannot replace `Cache-Control`, `Content-Type`, `Content-Encoding`, `Content-Length`, `Content-Range`, `Accept-Ranges`, or `Transfer-Encoding` on these files.

Header rules do not apply to ISR cache responses.

### Cookie headers

On a [Void platform](../deployment.md#deploy-to-a-team-platform), apps usually share an application domain, such as `apps.example.com`. Header rules on a platform deploy change two headers on all hostnames of the app, including custom domains:

- Void ignores `Set-Cookie` in header rules.
- Void removes the `"cookies"` directive from `Clear-Site-Data` in header rules. Other directives, such as `"cache"` and `"storage"`, still apply.
- Void ignores the full value of a `Clear-Site-Data` rule that includes `"*"`. The response then keeps the `Clear-Site-Data` value from your app's response, without `"cookies"`. If that value also includes `"*"`, the response has no `Clear-Site-Data`.

This stops a header rule from setting or clearing cookies for other apps on the same domain. These limits apply only to header rules. Your app's own response can set cookies and send `Clear-Site-Data`, and on a shared domain those can affect other apps. See [Domains and Resources](../platform/installation/domains.md#adding-a-domain).

During local development, with `void deploy --platform cloudflare`, and on [other runtimes](../deployment.md#other-runtimes), header rules apply both headers as written.

## Framework `_headers` files

Void reads `_headers` files produced by supported frameworks. Your `routing.headers` rules run afterward, so they can override framework defaults. No additional setup is needed.

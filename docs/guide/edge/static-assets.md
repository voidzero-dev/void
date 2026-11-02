---
outline: deep
---

# Static Assets Caching

Void caches static assets on Cloudflare's edge network. Hashed build files can be reused across deploys, while other files use cache keys tied to the deployment.

## Hashed assets

Files in Vite's `build.assetsDir` (default `assets/`) are produced with content hashes in the filename, such as `assets/app-Ab3xK9.js`. These files are immutable because the filename changes whenever the content changes, so they get aggressive caching:

```
Cache-Control: public, max-age=31536000, immutable
```

Browsers and the edge can cache these files for one year and reuse them across deploys.

If your Vite config customizes `build.assetsDir`, Void automatically detects this and applies the immutable optimization to the configured directory:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    assetsDir: 'static', // hashed assets go to dist/client/static/
  },
});
```

If `build.assetsDir` is set to `""`, meaning hashed files live at the root, the optimization is skipped because there is no directory-based way to distinguish hashed from non-hashed files.

Supported meta-frameworks use their own asset directories automatically.

### Native Cloudflare deployments

With `void deploy --platform cloudflare`, generated JavaScript bundles with content fingerprints receive immutable caching. Files copied from `public/` and custom build outputs with stable filenames keep normal revalidation, even when they live in the assets directory. CSS and other assets keep Cloudflare's default or your configured `Cache-Control`.

Use [Custom Headers](./headers) to choose a cache policy for other files. Apply immutable caching only to URLs that change whenever their content changes.

## Non-hashed assets

Other static files, such as `index.html` and `favicon.ico`, are cached until the next deploy. You do not need to purge them manually.

```
Cache-Control: public, s-maxage=31536000, max-age=0, must-revalidate
```

Browsers revalidate these files on each request.

**What gets cached:**

- All `GET` requests for non-SSR projects such as SPAs and static sites
- GET requests with file extensions (`.ico`, `.png`, `.css`, etc.) in SSR projects

**What does NOT get cached:**

- `/api/*` routes, which always hit the worker
- SSR-rendered pages (paths without file extensions in SSR projects)
- Non-GET requests
- Requests carrying `Cookie`, `Authorization`, or `Cf-Access-Jwt-Assertion` credentials
- Responses other than a complete `200`

### Opting out

If your worker serves dynamic content at a URL that looks static (e.g., a dynamically generated image at `/avatar.jpg`), you can prevent caching by setting `Cache-Control: private` or `Cache-Control: no-store` in your response headers. Any response with `Cache-Control` containing `private`, `no-store`, or `no-cache`, or with a `Set-Cookie` header, bypasses the edge cache.

## ETags and 304 Not Modified

Static assets include an `ETag` header. When a browser revalidates an unchanged file, Void returns `304 Not Modified` without downloading it again. No configuration is needed.

## Custom headers

You can override caching headers or add your own for any static asset path using [Custom Headers](./headers).

## Navigation and middleware

Void serves static files directly unless application code needs to handle the request first. API requests reach your Worker. Apps with middleware, routes outside `/api`, Pages, or SSR run application code before serving fallback HTML.

SPAs serve `index.html` for unmatched HTML navigation so client-side routing works. For a static site with a `404.html` page, set [`routing.notFound`](../../reference/config.md#routing-notfound):

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: { notFound: '404-page' },
});
```

Choose `single-page-application`, `404-page`, or `none`. These settings preserve which requests reach middleware and API handlers. Intentional API `404` responses keep their status and body.

SvelteKit, Nuxt, Analog, and Astro handle their own error pages and ignore `routing.notFound`. For direct Cloudflare deployment with TanStack Start, React Router, or vinext, configure the asset binding, directory, and routing policy through the framework's Cloudflare config.

## API routes and SSR pages

API responses and SSR pages are not cached as static assets. Use [Revalidation](./revalidation) to cache public rendered pages.

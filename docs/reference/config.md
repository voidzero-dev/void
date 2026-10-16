---
outline: deep
---

# Config

## Config File Format

Use `void.config.ts` to configure your app. For a guided introduction, start with [What is Void?](../guide/).

Put `void.config.ts` at the project root and import `defineConfig` from `void/config`. All fields are optional. `void init`, `void deploy`, and `void migrate` can convert older Void and Cloudflare JSON config files, saving backups under `.void/config-migration/`. Commit `void.config.ts` and `void.lock.json` when Void creates the lock; it records resource IDs and migration history.

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  sourceDir: 'src',
  target: 'cloudflare',
  auth: { providers: ['email', 'github', 'google'] },
  routing: {
    revalidate: { '/': 60, '*': 30 },
    headers: {
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
      '/*': ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff'],
    },
  },
  inference: {
    bindings: { db: true, kv: false },
    appType: 'spa',
    outputDir: 'dist',
  },
  worker: {
    compatibility_date: '2025-12-01',
    compatibility_flags: ['nodejs_compat'],
  },
  cloudflare: {
    name: 'my-app',
    account_id: 'your-account-id',
  },
});
```

TypeScript provides editor completion and checks. Void validates the config again when it runs, including values computed at runtime.

The shorter JSON fragments below show individual fields to place inside `defineConfig({ ... })`.

## Fields

### `sourceDir`

Directory containing Void source conventions, relative to the project root.

When omitted, Void uses the existing project-root conventions: `pages/`, `routes/`, `middleware/`, `crons/`, `queues/`, `db/`, `auth.ts`, and `env.ts`.

When set, those conventions move under the configured directory:

```json
{ "sourceDir": "src" }
```

With that config, Void reads `src/pages`, `src/routes`, `src/db/schema.ts`, `src/db/migrations`, `src/auth.ts`, and `src/env.ts`. Project files such as `void.config.ts`, `vite.config.ts`, `package.json`, `tsconfig.json`, `public/`, and the local-only `.env` stay at the project root. Void does not scan both locations; if source conventions exist in both places during dev/build, remove one copy so the active source tree is unambiguous.

### `ai`

`ai.gateway` names the Cloudflare AI Gateway that `ai.provider().fetch()` uses when your app runs on your own Cloudflare account. `ai.run()`, `ai.stream()`, and `ai.image()` use the Workers AI binding and do not need a gateway. On a Void platform, the platform selects the gateway and ignores this setting.

```json
{ "ai": { "gateway": "my-gateway" } }
```

See [AI on your Cloudflare account](../integrations/cloudflare.md#ai-self-host).

### `auth`

High-level Better Auth configuration.

Use `auth.providers` to select which built-in auth providers Void should enable by default. Include `"email"` for email/password auth. Social providers read credentials from `AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET`. `cognito` also needs a domain, region, and user pool ID: set `AUTH_COGNITO_DOMAIN`, `AUTH_COGNITO_REGION`, and `AUTH_COGNITO_USER_POOL_ID`, or set them in `auth.ts`.

```json
{
  "auth": {
    "providers": ["email", "github", "google", "discord"]
  }
}
```

If `auth` is omitted but auth is active via imports, Void enables email/password only. For provider-specific options, scopes, plugins, or custom OAuth flows, use a root `auth.ts` with `defineAuth(...)`.

Supported values for `auth.providers`:

- `email`
- `apple`
- `atlassian`
- `cognito`
- `discord`
- `dropbox`
- `facebook`
- `figma`
- `github`
- `gitlab`
- `google`
- `huggingface`
- `kakao`
- `kick`
- `line`
- `linear`
- `linkedin`
- `microsoft`
- `naver`
- `notion`
- `paybin`
- `paypal`
- `polar`
- `railway`
- `reddit`
- `roblox`
- `salesforce`
- `slack`
- `spotify`
- `tiktok`
- `twitch`
- `twitter`
- `vercel`
- `vk`
- `zoom`

### `database`

Database backend. Omit for D1/SQLite (default). Set to `"pg"` or `"mysql"` for an external database through Hyperdrive.

```json
{
  "database": "pg"
}
```

| Value       | Description                                             |
| ----------- | ------------------------------------------------------- |
| _(omitted)_ | D1 (SQLite), fully managed by Void with no extra config |
| `"pg"`      | PostgreSQL via Hyperdrive; bring your own database      |
| `"mysql"`   | MySQL via Hyperdrive; bring your own database           |

When using an external database:

- Add `DATABASE_URL` to `.env` for local development
- Import schema helpers from `void/schema-pg` or `void/schema-mysql`
- `void/db` connects via Hyperdrive in production, direct connection locally
- `void gen model` generates dialect-appropriate table and column builders

### `email`

Configuration for the [email integration](../guide/email.md).

```json
{
  "email": {
    "from": "Acme <noreply@mail.acme.com>"
  }
}
```

| Field  | Type     | Description                                                                                                    |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `from` | `string` | Default sender for `sendEmail()`: one address, optionally with a display name (`Acme <noreply@mail.acme.com>`) |

During development, `email.from` is the default sender in the local inbox. On a Void platform, use your project's shared sender or registered domain.

For direct Cloudflare deployment, this address selects the mail domain and default sender. Use a zone or subdomain in your account; an existing mail provider's MX records are preserved. Without `email.from`, Void skips automatic setup and preserves authored `cloudflare.send_email` bindings and `cloudflare.addresses`; check their readiness yourself. `--require-email` still refuses deployment when automatic setup cannot be verified. See [Email setup](../guide/email/domains.md#your-own-cloudflare-account).

### `head`

Site-wide HTML `<head>` defaults for pages mode. Sets a title template, default meta tags, links, scripts, and HTML/body attributes. Per-page `head()` exports and middleware defaults merge on top of these with clear precedence: **page > middleware > config**.

| Field           | Type                     | Description                                                      |
| --------------- | ------------------------ | ---------------------------------------------------------------- |
| `title`         | `string`                 | Default page title (overridden by page `head()`)                 |
| `titleTemplate` | `string`                 | Wraps the resolved title. `%s` is replaced with the page title.  |
| `meta`          | `Array<object>`          | Default `<meta>` tags (deduped by `name`/`property`, page wins)  |
| `link`          | `Array<object>`          | Default `<link>` tags (concatenated: config, middleware, page)   |
| `script`        | `Array<object>`          | Default `<script>` tags (concatenated: config, middleware, page) |
| `htmlAttrs`     | `Record<string, string>` | Attributes on `<html>` (shallow merge, page wins)                |
| `bodyAttrs`     | `Record<string, string>` | Attributes on `<body>` (shallow merge, page wins)                |

```json
{
  "head": {
    "titleTemplate": "%s | My Site",
    "htmlAttrs": { "lang": "en" },
    "meta": [
      { "charset": "utf-8" },
      { "name": "viewport", "content": "width=device-width, initial-scale=1" }
    ],
    "link": [{ "rel": "icon", "href": "/favicon.svg" }]
  }
}
```

See [Head Management](../guide/pages-routing/head) for the full merge behavior, `HeadDescriptor` shape, and per-page usage.

### `images`

Configuration for [`Image`, `getImageProps()`, and the `/_void/image` endpoint](../guide/images.md). The keys, types, and defaults match `images` in Next.js 16's `next.config.js`. Every key is optional.

| Key                       | Type                                                                           | Default                                           | Description                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceSizes`             | `Array<number>`                                                                | `[640, 750, 828, 1080, 1200, 1920, 2048, 3840]`   | Widths offered to images with `sizes` or `fill`. Up to 25 integers from 1 to 10000.                                                                                           |
| `imageSizes`              | `Array<number>`                                                                | `[32, 48, 64, 96, 128, 256, 384]`                 | Additional widths for fixed-size images and `sizes` narrower than the viewport. Up to 25 integers from 1 to 10000.                                                            |
| `qualities`               | `Array<number>`                                                                | `[75]`                                            | Allowed qualities. `quality` uses the closest value. 1 to 20 integers from 1 to 100.                                                                                          |
| `formats`                 | `Array<'image/avif' \| 'image/webp'>`                                          | `['image/webp']`                                  | Output formats, in order of preference, negotiated from the `Accept` header.                                                                                                  |
| `minimumCacheTTL`         | `number`                                                                       | `14400`                                           | Minimum `max-age` in seconds for optimized images.                                                                                                                            |
| `remotePatterns`          | `Array<URL \| RemotePattern>`                                                  | `[]`                                              | Remote sources, including redirect targets, the endpoint may fetch. Up to 50.                                                                                                 |
| `localPatterns`           | `Array<LocalPattern>`                                                          | Any path without a query string                   | Local sources the endpoint may load. Up to 25. Static `?image` imports are always allowed.                                                                                    |
| `dangerouslyAllowSVG`     | `boolean`                                                                      | `false`                                           | Serve SVG sources, unchanged, through the endpoint.                                                                                                                           |
| `dangerouslyAllowLocalIP` | `boolean`                                                                      | `false`                                           | Allow remote URLs whose host is `localhost` or a private or loopback IP address. Hostnames aren't resolved.                                                                   |
| `contentSecurityPolicy`   | `string`                                                                       | `"script-src 'none'; frame-src 'none'; sandbox;"` | `Content-Security-Policy` header of endpoint responses.                                                                                                                       |
| `contentDispositionType`  | `'inline' \| 'attachment'`                                                     | `'attachment'`                                    | `Content-Disposition` type of endpoint responses.                                                                                                                             |
| `maximumRedirects`        | `number`                                                                       | `3`                                               | Redirects followed for a remote source, from 0 to 20.                                                                                                                         |
| `maximumResponseBody`     | `number`                                                                       | `50000000`                                        | Largest source image in bytes. Values above 20 MB (`20000000`) are capped at 20 MB.                                                                                           |
| `loader`                  | `'default' \| 'custom' \| 'cloudflare' \| 'imgix' \| 'cloudinary' \| 'akamai'` | `'default'`                                       | How image URLs are built. See [Loaders](../guide/images.md#loaders). `imgix`, `cloudinary`, and `akamai` require `path` and build `<path>?url=…&w=…&q=…` URLs, as in Next.js. |
| `loaderFile`              | `string`                                                                       | —                                                 | Module whose default export is the loader for every image, relative to the project root.                                                                                      |
| `path`                    | `string`                                                                       | `'/_void/image'`                                  | Endpoint path for the default loader, or URL prefix for other loaders. `'/cdn-cgi/image'` with the `cloudflare` loader.                                                       |
| `unoptimized`             | `boolean`                                                                      | `false`                                           | Serve every image's `src` as is, without a `srcset`.                                                                                                                          |
| `domains`                 | `Array<string>`                                                                | `[]`                                              | Deprecated. Use `remotePatterns`.                                                                                                                                             |
| `maximumDiskCacheSize`    | `number`                                                                       | —                                                 | Accepted for Next.js compatibility. Has no effect, and Void prints a warning.                                                                                                 |
| `disableStaticImages`     | `boolean`                                                                      | `false`                                           | Accepted for Next.js compatibility. Has no effect, and Void prints a warning when `true`.                                                                                     |
| `customCacheHandler`      | `boolean`                                                                      | `false`                                           | Accepted for Next.js compatibility. Has no effect, and Void prints a warning when `true`.                                                                                     |

A `RemotePattern` is `{ protocol?: 'http' | 'https', hostname: string, port?: string, pathname?: string, search?: string }`. A `LocalPattern` is `{ pathname?: string, search?: string }`. In `pathname`, `*` matches one segment and `**` matches any number. In `hostname`, `*.example.com` and `**.example.com` match any subdomain of `example.com`. See [Allowed sources](../guide/images.md#allowed-sources).

```json
{
  "images": {
    "formats": ["image/avif", "image/webp"],
    "qualities": [50, 75, 90],
    "remotePatterns": [{ "protocol": "https", "hostname": "images.example.com" }]
  }
}
```

Void rejects unknown keys and out-of-range values when it reads the config. With a `node`, `bun`, or `deno` [`target`](#target), `output: "static"`, or on Void Platform, `Image` serves original files unless a custom loader or the `cloudflare` loader is set.

### `output`

Output mode. Controls the default rendering strategy for pages.

| Value                | Default prerender | Per-page override                | Prerender timing           |
| -------------------- | ----------------- | -------------------------------- | -------------------------- |
| `"server"` (default) | `false`           | `export const prerender = true`  | Deploy-time (platform ISR) |
| `"static"`           | `true`            | `export const prerender = false` | Build or deploy post-build |

When set to `"static"`, pages are prerendered to HTML in `dist/client/`. Individual pages can opt out with `export const prerender = false`. Dynamic pages need `getPrerenderPaths()` to be prerendered.

When omitted or set to `"server"`, pages are server-rendered on request. Individual pages can opt into deploy-time prerendering with `export const prerender = true`, or opt out of server-rendered component HTML with `export const ssr = false`.

```json
{ "output": "static" }
```

Static output has no `/_void/image` endpoint, so `Image` serves original files unless you set a [custom loader](../guide/images.md#loaders).

### `remote`

Use a deployed Void project's D1, KV, and R2 resources during local development. Writes affect real data. See [Remote Development](../guide/remote-dev.md).

```json
{ "remote": true }
```

**Requirements:**

- Must be logged in (`void account login`)
- Must have a linked project (`void project link`)
- Only affects D1 (`DB`), KV (`KV`), and R2 (`STORAGE`) bindings

You can also enable remote mode via the `VOID_REMOTE=1` environment variable without modifying `void.config.ts`:

```bash
VOID_REMOTE=1 pnpm dev
```

### `sandbox`

Enable and configure Cloudflare Sandboxes. Importing from `void/sandbox` enables this automatically.

```json
{
  "sandbox": {
    "image": "./Dockerfile.sandbox",
    "platformImage": "registry.cloudflare.com/<account-id>/sandbox@sha256:<digest>",
    "instanceType": "standard-1"
  }
}
```

| Field               | Type     | Default                     |
| ------------------- | -------- | --------------------------- |
| `binding`           | `string` | `SANDBOX`                   |
| `className`         | `string` | `SandboxV1`                 |
| `containerName`     | `string` | `void-sandbox-v1`           |
| `image`             | `string` | Packaged Node.js Dockerfile |
| `imageBuildContext` | `string` | Directory of `image`        |
| `platformImage`     | `string` | `cloudflare/debian-trixie`  |
| `instanceType`      | `string` | `lite`                      |

Supported sizes are `lite` and `standard-1` through `standard-4`. Native deploys build Dockerfiles with Docker; registry images must be digest-pinned references from the Cloudflare managed registry. Custom images must include the matching Sandbox SDK helper. For a local Dockerfile, supply `platformImage` when deploying to a managed platform. See [Sandboxes](../guide/sandboxes.md) for image setup and runtime examples.

Sandbox requires [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) and Containers access. Managed runtime tokens need Account / Containers: Edit and Account / Cloudchamber: Edit. See [Sandbox deployment](../guide/sandboxes.md#deployment).

### `target`

Deploy target runtime. Defaults to `"cloudflare"`.

| Value          | Description                                               |
| -------------- | --------------------------------------------------------- |
| `"cloudflare"` | Cloudflare Workers (default), with full platform features |
| `"node"`       | Node.js, using `@hono/node-server`                        |
| `"bun"`        | Bun, using `Bun.serve()`                                  |
| `"deno"`       | Deno, using `Deno.serve()`                                |

Non-CF targets disable CF binding imports (`void/db`, `void/kv`, `void/auth`, `void/storage`, `void/ai`, `void/sandbox`, `void/env`). Importing any of these with a non-CF target produces a compile-time error. File-based routing, middleware, and `void/client` all work normally. `Image` from the Pages adapters serves original files on these targets unless you set a [custom loader](../guide/images.md#loaders).

Void-managed WebSocket route files (`*.ws.ts`) are Cloudflare-only because they compile to Durable Objects. The `void/ws` subpath itself is not blocked on non-CF targets so client-side `connect()` code can still be bundled where a browser-like `WebSocket` runtime is available.

```json
{ "target": "node" }
```

### `worker`

Curated Cloudflare Workers configuration. `void init` pins `compatibility_date` here. Binding arrays such as `d1_databases`, `kv_namespaces`, and `r2_buckets` go in [`cloudflare`](#cloudflare), where Void preserves custom settings and resolved IDs during deployment.

| Field                 | Type       | Description                            |
| --------------------- | ---------- | -------------------------------------- |
| `compatibility_date`  | `string`   | Cloudflare Workers compatibility date  |
| `compatibility_flags` | `string[]` | Cloudflare Workers compatibility flags |
| `vars`                | `object`   | Plain-text worker variables            |
| `limits`              | `object`   | Worker resource limit overrides        |

```json
{
  "worker": {
    "compatibility_date": "2025-12-01",
    "compatibility_flags": ["nodejs_compat"],
    "vars": {
      "PUBLIC_API_BASE": "https://api.example.com"
    }
  }
}
```

`worker.vars` values must be strings. Root `.env` values override them during local development only. Production builds do not load `.env`, and reject any `worker.vars` name declared as a server key in `env.ts`. Use `void secret put` for production server values.

Managed deployments include `worker.vars` as plain-text bindings. A remote secret with the same name takes precedence. To use the configured variable instead, remove that remote secret and deploy again. Secret deletion changes the running Worker immediately, so plan this migration during a maintenance window.

`worker.limits.cpu_ms` sets the CPU time limit per request, from 1 to 300000 ms. On a Void platform, deploy fails if the limit exceeds the account plan; lower it in `void.config.ts` before retrying. Rollback instead caps the old limit at the current plan ceiling. On direct deploys, [Cloudflare enforces the value](https://developers.cloudflare.com/workers/platform/limits/#cpu-time): Workers Free allows up to 10 ms and Workers Paid up to 300000 ms per request.

```json
{
  "worker": {
    "limits": {
      "cpu_ms": 30000
    }
  }
}
```

### `cloudflare`

The complete Cloudflare Worker configuration for direct Cloudflare builds and deployment. Put custom bindings, `name`, `account_id`, routes, services, vars, migrations, and any other Cloudflare fields here. Void passes these fields through to the generated Cloudflare build configuration. Settings you edit here take precedence over values Void previously recorded in `void.lock.json`.

```ts
// Inside defineConfig({ ... })
cloudflare: {
  name: 'my-app',
  d1_databases: [{ binding: 'ANALYTICS', database_name: 'analytics', database_id: '...' }],
  vars: { PUBLIC_API_BASE: 'https://api.example.com' },
},
```

Void writes a generated Cloudflare config for its tooling and records provisioned resource IDs and append-only migration history in `void.lock.json`. Commit the lock when it changes. Root `wrangler.jsonc` and `wrangler.json` are migrated on `void init` or `void deploy`; Void keeps backup copies under `.void/config-migration/`.

If you need to remove a value that Void previously generated, remove it from the `resolved` object in `void.lock.json`. Void refreshes the generated Cloudflare file on the next command. Put ongoing custom settings in `cloudflare` in `void.config.ts`.

### `deploy.cloudflare.mode`

Direct Cloudflare deploys use `staged` by default: Void checks the new Worker before sending it production traffic. If Cloudflare cannot stage an existing Durable Object Worker, choose `atomic` after reviewing the pending Worker and database changes:

```ts
// Inside defineConfig({ ... })
deploy: { cloudflare: { mode: 'atomic' } },
```

This choice applies to subsequent `void deploy` runs. Atomic deployment sends traffic to the new Worker before Void checks readiness; a Durable Object class migration cannot be rolled back across its migration boundary. Use `--atomic` for a single deployment instead. `deploy` is a Void setting and is not passed to Cloudflare's Worker config.

### `routing`

Routing and edge configuration for headers, redirects, rewrites, and caching.

#### `routing.headers`

Custom response headers. Keys are URL patterns, values are arrays of `"Name: value"` strings. See [Custom Headers](../guide/edge/headers) for details.

```json
{
  "routing": {
    "headers": {
      "/assets/*": ["Cache-Control: public, max-age=31536000, immutable"],
      "/*": ["X-Frame-Options: DENY", "X-Content-Type-Options: nosniff"]
    }
  }
}
```

#### `routing.redirects`

URL redirects. Keys are source URL patterns, values are destination strings (302 default) or objects with `to` and optional `status` (`301`, `302`, `303`, `307`, `308`). See [Redirects](../guide/edge/redirects) for details.

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

#### `routing.rewrites`

URL rewrites. Keys are source URL patterns, values are destination paths. Serves content from the destination without changing the browser URL. See [Rewrites](../guide/edge/rewrites) for details.

```json
{
  "routing": {
    "rewrites": {
      "/": "/en",
      "/docs/*": "/en/docs/:splat"
    }
  }
}
```

Destinations use the `RewriteDestination` shape — typed route patterns plus `string`, so known routes autocomplete while dynamic paths remain accepted. See [Programmatic rewrites](../guide/edge/rewrites#programmatic-rewrites-in-middleware).

#### `routing.fallbacks`

Fallback rewrites. Same shape as `rewrites`, but rules only fire when no static asset or route matched the request (i.e. the request would otherwise 404). Useful for SPA shells or default-locale catch-alls that shouldn't pre-empt real routes. See [Rewrites → Fallbacks](../guide/edge/rewrites#fallbacks) for details.

```json
{
  "routing": {
    "fallbacks": {
      "/*": "/index.html"
    }
  }
}
```

#### `routing.isr`

Boolean switch for Void's ISR caching. When omitted or `true`, Void infers caching from your revalidate and prerender settings. Setting it to `false` disables ISR and edge prerendering for the whole app, including per-page exports:

```json
{
  "routing": {
    "isr": false
  }
}
```

Build-time HTML generation with `output: "static"` is unaffected. Set `isr` to `true` to enable your configured cache policies again.

#### `routing.revalidate`

ISR revalidation TTL in seconds, either globally or per path. See [Revalidation](../guide/edge/revalidation.md) for details.

```json
{
  "routing": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "*": 30
    }
  }
}
```

#### `routing.revalidateQueryAllowlist`

Query parameters to keep in ISR cache keys. Keys are source URL patterns, values are query parameter names to keep. The listed parameters are part of the cache key for every request to a matching path; all other query parameters are left out of the key. When omitted, ISR cache keys drop every incoming query parameter to avoid unbounded cache fanout.

```json
{
  "routing": {
    "revalidateQueryAllowlist": {
      "/search": ["q"],
      "/products/*": ["variant", "currency"],
      "*": []
    }
  }
}
```

#### `routing.prerender`

Paths to prerender as static HTML at deploy time. Each path must start with `/`. See [Edge Prerendering](../guide/edge/prerendering.md) for details.

```json
{
  "routing": {
    "prerender": ["/", "/about", "/pricing"]
  }
}
```

#### `routing.notFound`

Override how the asset layer answers a request that matched no asset and no worker route. One of `"single-page-application"`, `"404-page"`, or `"none"`. If omitted, Void infers it — see [Static Assets](../guide/edge/static-assets.md#navigation-and-middleware).

```json
{
  "routing": {
    "notFound": "404-page"
  }
}
```

Use `"404-page"` for a generated static site with a `404.html`, `"single-page-application"` for a client router, or `"none"` to keep the Worker's own 404. API and middleware routing remain unchanged.

SvelteKit, Nuxt, Analog, and Astro use their own error pages and ignore this setting. For direct Cloudflare deployment with TanStack Start, React Router, or vinext, set a complete asset policy in your framework's Cloudflare config. See [Static Assets](../guide/edge/static-assets.md#navigation-and-middleware).

### `inference`

Configuration for build-time inference, including how Void detects your app type, bindings, and build process.

#### `inference.bindings`

Explicitly control inferred Cloudflare bindings. If omitted, bindings are [automatically inferred](./resource-inference.md) by scanning your source files for binding usage. Explicit values override the named bindings; omitted bindings are still inferred. Auth and checked-in migrations still require a database even when `db` is `false`.

Each binding accepts `true` (use default name), `false` (disable), or a string (custom binding name):

```json
{
  "inference": {
    "bindings": {
      "db": true,
      "kv": false,
      "storage": "MY_BUCKET",
      "ai": "MY_AI",
      "images": "MY_IMAGES"
    }
  }
}
```

| Key       | Default Binding | Type            | Custom Name              |
| --------- | --------------- | --------------- | ------------------------ |
| `db`      | `DB`            | `D1Database`    | `"db": "MY_DB"`          |
| `kv`      | `KV`            | `KVNamespace`   | `"kv": "MY_KV"`          |
| `storage` | `STORAGE`       | `R2Bucket`      | `"storage": "MY_BUCKET"` |
| `ai`      | `AI`            | `Ai`            | `"ai": "MY_AI"`          |
| `images`  | `IMAGES`        | `ImagesBinding` | `"images": "MY_IMAGES"`  |
| `email`   | —               | —               | Boolean only             |

Custom binding names work with `void/db`, `void/kv`, and `void/storage` during development and deployment. Custom AI names also work with `void/ai` on direct Cloudflare deploys; managed Workers AI uses the platform's proxy. A custom Images name also works with `Image` and `/_void/image`, and an `images` binding you declare under [`cloudflare`](#cloudflare) keeps its name. Set `images` to `true` or a name to add the binding and serve `/_void/image` even when Void doesn't detect `Image` usage, for example when only a shared package imports `Image`. Set `images` to `false` to deploy without the binding; `/_void/image` then serves original files. See [Images](../guide/images.md#deployment).

`email` is a boolean feature switch. Set it to `true` to enable [email](../guide/email.md) and the `void dev` inbox without an import from `void/email`, or `false` to disable them. On a Void platform, sending uses the platform proxy. Direct Cloudflare setup records a `SEND_EMAIL` binding in `void.lock.json`; see [`email.from`](#email).

#### `inference.build`

Override the build command. Useful for frameworks with their own CLIs (Nuxt, Astro) or static apps with custom build scripts. If omitted, the CLI uses the detected default build command for the current app type. It applies to every app type, including `"void"` (where the default is `vite build`).

```json
{ "inference": { "build": "nuxt build --preset cloudflare-module" } }
```

The command is run through a shell from the project root, with the project's own `node_modules/.bin` on `PATH`, so bare binaries and `&&` chains work:

```json
{ "inference": { "build": "vitepress build && vite build" } }
```

That chain is how a static site generator and a Void backend ship together — see [Adding a backend to a static site](../guide/app-types.md#adding-a-backend-to-a-static-site).

#### `inference.scanDirs`

Override which directories are scanned for [binding inference](./resource-inference.md). Paths are relative to the project root. Replaces the default directories for the current mode.

```json
{ "inference": { "scanDirs": ["src", "lib", "workers"] } }
```

#### `inference.appType`

App type. If omitted, auto-detected on first deploy. See [Supported App Types](../guide/app-types.md).

- `"void"`: worker plus assets, including API routes, SSR, and jobs
- `"framework"`: a meta-framework app such as TanStack Start, React Router, SvelteKit, Nuxt, or Astro
- `"static"`: fully rendered HTML files from VitePress, plain HTML, or external tools. Non-matching paths return `404.html` or a 404 response.
- `"spa"`: static output with SPA fallback. Non-file paths fall back to `index.html` with a `200` status so client-side routing works out of the box.

#### `inference.outputDir`

Output directory for static deploys, relative to the project root. Only relevant when `inference.appType` is `"spa"` or `"static"`. Defaults to `"dist"`.

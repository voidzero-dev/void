---
description: 'Build a Void server for Node.js, Bun, or Deno, and run it on your own machine, in a container, or with another host.'
outline: deep
---

# Node.js, Bun, and Deno

Set `target` in `void.config.ts` to build for Node.js, Bun, or Deno. You can run the resulting server on your own machine, in a container, or with a hosting provider.

```json
{ "target": "node" }
```

## Getting Started

### 1. Configure the target

```json
// void.config.ts
{ "target": "node" }
```

### 2. Install the server dependency (Node.js only)

Node.js requires `@hono/node-server` as an additional dependency. Bun and Deno use their built-in HTTP servers.

```bash
npm install @hono/node-server
```

### 3. Develop

```bash
npx vite dev
```

The development server reloads routes and pages when you edit them.

### 4. Build and run

```bash
npx vite build
node dist/ssr/index.js
```

For Bun:

```bash
bunx vite build
bun dist/ssr/index.js
```

For Deno:

```bash
deno run -A npm:vite build
deno run -A dist/ssr/index.js
```

Run these commands from your app directory. The server listens on `PORT` (env variable) or `3000` by default.

Deploy `dist/ssr` and `dist/client` together.

## Build Output

The build produces two entry points:

```
dist/
  ssr/
    app.js       ← Hono app with static asset middleware (default export)
    index.js     ← imports app.js and starts the HTTP server
  client/        ← static assets (pages mode only)
    .vite/manifest.json
    assets/
      ...
```

- **`app.js`:** exports the Hono app instance. Use it for programmatic embedding, testing, or custom server setups.
- **`index.js`:** imports `app.js` and starts the server. This is what you run in production.

`vite preview` also uses `app.js` to serve your built app locally.

Installed packages that depend on `void` are bundled into `dist/ssr`. If one of their dependencies uses a native addon or reads files next to its own code, add that dependency, in the version the package uses, to your app's `dependencies`. The build then leaves it to Node.

## What Works

These Void features work identically across all targets:

- [File-based routing](../guide/server-routing.md) (`routes/`, `middleware/`)
- [Pages mode](../guide/pages-routing/overview.md) with SSR (React, Vue, Svelte, Solid)
- [Typed fetch client](../guide/typed-fetch.md) (`void/client`)
- [Custom headers](../guide/edge/headers.md) (`routing.headers`)
- [Redirects](../guide/edge/redirects.md) (`routing.redirects`)
- [Static site generation](../guide/ssg.md)
- [Image generation](../guide/image-generation.md) (`void/image`) and [Open Graph images](../guide/og-images.md) (`void/og`), with `takumi-js` installed as described below
- [Vite preview](https://vite.dev/guide/cli#vite-preview) for testing production builds locally

## What's Different

### Environment variables

Supply server values through your host's environment and read them with `process.env` in Node.js or Bun, or `Deno.env.get()` in Deno. The `void/env` schema and secret workflow requires Cloudflare.

For browser code, use Vite's `import.meta.env.VITE_*` values. These are embedded at build time and must not contain secrets.

### Image generation & Open Graph images

Both image APIs work on Node.js, Bun, and Deno:

- [`ImageResponse` from `void/image`](../guide/image-generation.md) generates images with required `width` and `height` options.
- [`OgImageResponse` from `void/og`](../guide/og-images.md) extends `ImageResponse` for Open Graph and social previews, defaulting to 1200 × 630 pixels.

For either API, add `takumi-js` to your app's `dependencies` (not `devDependencies`, so production installs include it):

```sh
npm install takumi-js@~2.20.0
```

See the [image generation guide](../guide/image-generation.md#node-js-bun-and-deno) for production setup and font memory considerations.

### No Cloudflare bindings

The following imports are **not available** with a non-CF target and produce a compile-time error:

| Import         | CF Feature               |
| -------------- | ------------------------ |
| `void/db`      | D1 (SQL database)        |
| `void/kv`      | KV (key-value storage)   |
| `void/storage` | R2 (blob storage)        |
| `void/auth`    | Void-managed Better Auth |
| `void/ai`      | Workers AI               |
| `void/sandbox` | Cloudflare Sandboxes     |
| `void/env`     | Typed environment schema |

If you need a database or storage, use an external provider and connect via standard Node.js libraries.

WebSocket route files (`*.ws.ts`) require Cloudflare. You can still use the `void/ws` browser client to connect to a separately hosted WebSocket server.

### No cron job runtime

You can still define [cron jobs](../guide/jobs.md) in `crons/` and they will compile into the bundle, but there is no built-in scheduler to invoke them. On Cloudflare, Workers Cron Triggers call the `scheduled` handler automatically. On Node.js, you'll need an external scheduler (e.g. `node-cron`, systemd timers, or your hosting platform's cron) to trigger the exported handler.

### No inbound email

[Inbound email handlers](../guide/email/receiving.md#inbound) and `sendEmail` require Cloudflare. Use an external mail provider on other targets.

### No prerendering

[Edge prerendering](../guide/edge/prerendering.md) requires Cloudflare. Build-time [static generation](../guide/ssg.md) is available on all targets.

### No `void deploy`

`void deploy` handles Cloudflare and Void platform deployments. For Node.js, Bun, or Deno, run `vite build` and deploy `dist/` using your hosting provider's workflow.

### Ignored config fields

Void warns and ignores these Cloudflare-specific `void.config.ts` fields on other targets:

- `inference.bindings`: Cloudflare binding configuration
- `remote`: remote binding proxy
- `worker`: Cloudflare-specific config
- `routing.revalidate`: edge caching, only on Cloudflare

If you enable auth through `void/auth`, `void/client`, or `auth.ts`, Void fails the build for non-CF targets. Use Better Auth directly for Node/Bun/Deno deployments.

## Programmatic Usage

Since `app.js` exports the Hono app, you can import it into a custom server:

```ts
import app from './dist/ssr/app.js';

// Use with any Node.js HTTP framework
const response = await app.fetch(new Request('http://localhost/api/hello'));
console.log(await response.json()); // { message: "Hello from Node.js!" }
```

This is useful for testing, embedding in Express/Fastify, or running in serverless environments that accept a `fetch` handler.

### Serving the client build from somewhere else

By default, `app.js` serves the client build from `dist/client`, next to `dist/ssr`. To serve it from elsewhere, such as from inside a [single executable application](https://nodejs.org/api/single-executable-applications.html), pass an `ASSETS` object with a `fetch(request)` method in the env. Void then reads the client manifest, scripts, styles and `public/` files through it, and doesn't look for `dist/client`.

This server reads the client build from a single executable's assets, stored under their URL paths (`/.vite/manifest.json`, `/assets/…`, and `public/` files):

```ts
import { getAsset } from 'node:sea';
import { serve } from '@hono/node-server';
import app from './dist/ssr/app.js';

const types: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const ASSETS = {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      const type = types[pathname.slice(pathname.lastIndexOf('.'))] ?? 'application/octet-stream';
      return new Response(getAsset(pathname), { headers: { 'content-type': type } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  },
};

serve({ fetch: (request, env) => app.fetch(request, { ...env, ASSETS }), port: 3000 });
```

Keep the env the server passes in: on Node.js it carries the incoming request, which `getConnInfo()` reads.

With Bun, `bun build --compile` embeds a file only when the code imports it with `{ type: 'file' }`. Listing `dist/client` files as extra entry points doesn't work, because Bun bundles JavaScript entry points as code. Client file names change with every build, so write the imports into a module after `vite build`, one per file in `dist/client`:

```ts
// client-files.ts, written after each `vite build`
import manifest from './dist/client/.vite/manifest.json' with { type: 'file' };
import pagesClient from './dist/client/assets/pages-client-BZk7n9j7.js' with { type: 'file' };

const files: Record<string, string> = {
  '/.vite/manifest.json': manifest,
  '/assets/pages-client-BZk7n9j7.js': pagesClient,
};
export default files;
```

Then serve them from the compiled executable, passing Bun's `Server` as `server` so `getConnInfo()` still works:

```ts
import files from './client-files.ts';
// server.ts, compiled with `bun build --compile server.ts --outfile server`
import app from './dist/ssr/app.js';

const ASSETS = {
  async fetch(request: Request): Promise<Response> {
    const path = files[new URL(request.url).pathname];
    return path ? new Response(Bun.file(path)) : new Response('Not Found', { status: 404 });
  },
};

Bun.serve({ fetch: (request, server) => app.fetch(request, { server, ASSETS }), port: 3000 });
```

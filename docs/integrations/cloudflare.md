---
outline: deep
---

# Cloudflare

Void runs on Cloudflare Workers. It detects the resources your app uses, creates bindings, and deploys to your account.

## Bindings

In Void routes and middleware, use `c.env`:

```ts
// routes/api/users.ts
import { defineHandler } from 'void';

export const GET = defineHandler(async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM users').all();
  return c.json({ users: results });
});
```

TanStack Start and React Router can import bindings from `cloudflare:workers`:

```ts
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```

Other frameworks use their own binding access. Follow your [framework's setup guide](./frameworks/overview.md).

### TypeScript setup

Add `void/env` to your TypeScript types:

```json
{
  "compilerOptions": {
    "types": ["void/env"]
  }
}
```

This provides binding types and Workers runtime types.

### Available bindings

| Binding          | Resource        | Use in your app                               |
| ---------------- | --------------- | --------------------------------------------- |
| `DB`             | D1              | `c.env.DB` or `void/db`                       |
| `KV`             | KV              | `c.env.KV` or `void/kv`                       |
| `STORAGE`        | R2              | `c.env.STORAGE` or `void/storage`             |
| `AI`             | Workers AI      | `c.env.AI` or `void/ai`                       |
| `IMAGES`         | Images          | `Image`, `getImageProps()`, or `c.env.IMAGES` |
| `QUEUE_*`        | Queues          | `defineQueue()` or `void/queues`              |
| Filename-derived | Durable Objects | A module in `durable-objects/`                |

Use [binding configuration](../reference/resource-inference.md#explicit-binding-overrides) when you need to enable, disable, or rename an inferred binding.

## Cloudflare Configuration

Define Worker settings in `void.config.ts`:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  worker: {
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat'],
  },
  cloudflare: {
    name: 'my-app',
    services: [{ binding: 'API', service: 'my-api-worker' }],
  },
});
```

Put binding arrays, resource IDs, routes, and service bindings under `cloudflare`. Void preserves your configured bindings and adds missing inferred resources. The `worker` field takes precedence for compatibility settings and variables. See [Configuration](../reference/config.md).

Commit `void.lock.json` when Void records resource IDs or Durable Object migrations. Keep generated Cloudflare config out of Git. Frameworks that require an adapter config path use `.void-wrangler.jsonc`; their setup guides show the required options.

Declare environment variables in `env.ts`, put local values in `.env`, and set production server values with `void secret put`. See [Environment Variables](../guide/env-vars.md).

## Deploy to your own Cloudflare account

Choose Cloudflare during `void init`, then deploy:

```sh
void deploy
```

Void opens your browser to sign in and asks which account to use when you have several. If the browser doesn't open, follow the link and confirm the code printed in the terminal.

To set up deployment later, run `void connect --platform cloudflare`. To select Cloudflare for one deploy, run:

```sh
void deploy --platform cloudflare
```

Use `void cloudflare login`, `status`, and `logout` to manage your session.

### Deploy an existing Worker

For an existing Void app deployed directly to Cloudflare, keep its root `wrangler.jsonc` or `wrangler.json` and run:

```sh
void deploy
```

If no destination is selected, Void offers to link the existing Worker. Accept to sign in and deploy. Void migrates the configuration to `void.config.ts` and `void.lock.json`, preserving bindings, variables, secrets, routes, and schedules. Commit both files.

Keep the first deployment focused on the existing app. Add resources, auth, migrations, or other runtime features after linking. If the Worker has a newer inactive upload, activate or remove it in Cloudflare before retrying.

Readiness checks need either an existing [version metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/) or access to [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/). Void stops before activation if neither is available.

Prerendered pages can require a new ISR cache. Void asks whether to enable it and saves the choice as `routing.isr`. Choose `false` to render those pages on each request instead. In CI, set that choice before deploying. Existing caches retain their IDs.

If linking reports a missing binding, use the existing Worker's binding name and resource ID in `cloudflare` and `inference.bindings`. Keep `.void/cloudflare-link.json` when retrying.

Before changing dashboard-managed triggers or visibility later, add the current `routes`, `workers_dev`, and `preview_urls` to your config. Convert `wrangler.toml` to JSON/JSONC before linking. Named environments need separate Void project configs.

### What happens during deploy

Void creates missing resources, builds the app, checks secrets and migrations, uploads the Worker, verifies readiness, and updates traffic and triggers. Resource IDs are saved in `void.lock.json`.

A failed build or validation can leave provisioned resources in your account. Run the first deploy from one machine at a time, then commit the lock file before deploying from other machines or CI.

Apps using email need `email.from` in `void.config.ts`. Void reviews the domain's setup before building and asks before changing it. See [Email](../guide/email/domains.md#your-own-cloudflare-account).

### Deploying from CI

Set these CI secrets and variables as needed:

| Name                                             | When needed                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                           | Required. Workers Scripts: Edit, read access to bound resources, and edit access to products Void provisions. |
| `CLOUDFLARE_ACCOUNT_ID`                          | When the token can access several accounts.                                                                   |
| `DATABASE_URL`                                   | PostgreSQL and MySQL provisioning and migrations.                                                             |
| `CLOUDFLARE_WORKERS_SUBDOMAIN`                   | When the Worker has no version preview URL. Use `my-team` or `my-team.workers.dev`.                           |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | When Cloudflare Access protects the readiness URL.                                                            |

For email, run `void email setup --platform cloudflare` locally, commit `void.lock.json`, and pass `--require-email` in CI. The token also needs Email Routing Edit and Email Sending Edit.

#### Cloudflare Access

For local deployment to an Access-protected Worker, you can use a short-lived user session:

```sh
export CF_ACCESS_TOKEN="$(cloudflared access token --app=https://<worker>.<account>.workers.dev)"
```

Void uses Access credentials for readiness checks without saving them. If checks are denied, the deployment fails. A first-deploy bootstrap can already be active behind Access when this happens.

### Databases and secrets

For PostgreSQL and MySQL, supply `DATABASE_URL` to the deploy process. Void uses it for Hyperdrive and migrations without writing it to config. MySQL schema changes can partially apply before an error; see [failed MySQL migrations](../guide/database/mysql.md#failed-migrations).

Creating Hyperdrive requires an API token with Hyperdrive edit permission. Alternatively, create it in Cloudflare and add its ID to `cloudflare.hyperdrive`; an existing binding works with browser login.

Run `void db generate` and commit migrations before deploying schema changes. This includes Better Auth tables. Custom D1 migration directories, tables, and patterns are supported; deploy stops if the files to apply differ from the validated history.

Set production server values with `void secret put <NAME>`. Void preserves existing remote secrets and creates `BETTER_AUTH_SECRET` when an auth app needs one. Local `.env` values are never deployed.

### Readiness and rollback

Void normally verifies an uploaded version before sending it traffic. If readiness or trigger updates fail, it restores the previous deployment. Finish or cancel any gradual rollout in Cloudflare before deploying through Void.

For an existing Durable Object Worker that Cloudflare cannot stage, review the changes and use:

```sh
void deploy --platform cloudflare --atomic
```

To use this on every deploy, set `deploy: { cloudflare: { mode: 'atomic' } }`. Atomic deployment sends traffic to the new version before its readiness check. Durable Object class migrations cannot be rolled back across their migration boundary.

A new Worker may need an active first deployment before readiness can be checked. Keep `.void/cloudflare-candidate.json` if a staged upload fails so you can retry from the same checkout.

Inspect or restore versions with:

```sh
void project status
void project rollback [version]
```

Void restores recorded triggers along with the code. Versions without a complete trigger snapshot keep current routes and schedules. Rollback does not reverse database migrations.

#### Scope and limitations

Void deploys native apps, static sites, SPAs, supported SSGs, and Cloudflare builds from TanStack Start, React Router, SvelteKit, Nuxt, Analog, and Astro. The vinext adapters are experimental.

- Native apps support Void routing rules. Framework apps on the direct target must configure redirects, rewrites, fallbacks, and headers through their framework or Worker.
- `--skip-build` works for existing static output. Worker apps require a fresh build.
- Named Cloudflare environments aren't supported. Use a separate Void project config for each target.
- Sandbox requires Workers Paid and Docker. See [Sandbox requirements](../guide/sandboxes.md#deployment) for plan and token permissions.
- Email to arbitrary recipients requires Workers Paid; verified recipients and inbound mail work on Workers Free. See [Email](../guide/email/domains.md#your-own-cloudflare-account).
- Image optimization works on Workers Free with the Cloudflare Images Free plan: 5,000 unique transformations per month. After that, new image sizes serve the original file until the next month, at no charge. See [Images](../guide/images.md#free-allowance).
- Node.js, Bun, and Deno use their [own deployment path](./nodejs-bun-deno.md).

Commit Durable Object migration history in `void.lock.json`. Do not delete or reorder deployed steps.

### Managing the deployed app

`void secret`, `void domain`, `void project status|list|logs|rollback`, and remote `void db` commands use the selected account and Worker. Logs are a live tail.

Custom domain commands update routes immediately. If a first deployment times out while DNS or TLS is propagating, check the domain in Cloudflare and retry once `/__void/ready` is reachable.

`void project delete` does not remove Cloudflare resources. Review ownership and remove them in Cloudflare.

### Local development

Local D1, KV, and R2 bindings use local data. Your production resource IDs are used during deployment.

Images are resized and converted locally, without a Cloudflare connection, and don't count toward your Images allowance. Quality settings only apply on Cloudflare.

Workers AI runs remotely after you connect to Cloudflare, so development calls consume your account's allowance. Remote bindings in development and preview use your `void cloudflare login` session, or `CLOUDFLARE_API_TOKEN` when it is set.

### AI on your Cloudflare account {#ai-self-host}

`ai.run()`, `ai.stream()`, and `ai.image()` use your Workers AI binding. For provider models, configure your AI Gateway and store the provider key as a Worker secret:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  ai: { gateway: 'my-gateway' },
});
```

```sh
void secret put OPENAI_API_KEY
```

`ai.provider('openai').fetch(...)` then uses that gateway and key. See the [AI guide](../guide/ai.md) for examples. Use [AI Gateway analytics](https://developers.cloudflare.com/ai-gateway/) to inspect account usage.

### ISR on your Cloudflare account {#isr-self-host}

Configure [revalidation](../guide/edge/revalidation.md) globally, per path, or per page. Void provisions the cache automatically.

`revalidate()` clears shared storage and the current data center's edge cache. Other data centers can serve cached responses until their cache lifetime expires. Pages data requests in a data center that hasn't rendered the HTML are generated live.

Each deploy starts with a fresh cache.

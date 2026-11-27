---
description: 'Deploy to Cloudflare Workers. Void detects the resources your app uses, creates bindings, and publishes the Worker.'
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

This provides binding and Workers runtime types. For custom bindings in `void.config.ts`, run `void prepare` or start the dev server or build to type them on `c.env`. See [Custom Binding Types](../guide/type-safety.md#custom-binding-types) for RPC methods on service and Durable Object bindings.

### Available bindings

| Binding          | Resource        | Use in your app                   |
| ---------------- | --------------- | --------------------------------- |
| `DB`             | D1              | `c.env.DB` or `void/db`           |
| `KV`             | KV              | `c.env.KV` or `void/kv`           |
| `STORAGE`        | R2              | `c.env.STORAGE` or `void/storage` |
| `AI`             | Workers AI      | `c.env.AI` or `void/ai`           |
| `ASSETS`         | Static assets   | `c.env.ASSETS.fetch(request)`     |
| `QUEUE_*`        | Queues          | `defineQueue()` or `void/queues`  |
| Filename-derived | Durable Objects | A module in `durable-objects/`    |

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

| Name                                             | When needed                                                                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                           | Required. Workers Admin for the first deploy, or Workers Editor to deploy to an existing Worker.                                                                                          |
| `CLOUDFLARE_ACCOUNT_ID`                          | When the token can access several accounts.                                                                                                                                               |
| `DATABASE_URL`                                   | PostgreSQL and MySQL provisioning and migrations.                                                                                                                                         |
| `CLOUDFLARE_WORKERS_SUBDOMAIN`                   | When workers.dev is enabled and the version has no preview URL. Use `my-team` or `my-team.workers.dev`. An account subdomain does not create a readiness URL when `workers_dev` is false. |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | When Cloudflare Access protects the readiness URL.                                                                                                                                        |
| `CF_ACCESS_READINESS_ORIGIN`                     | When Access protects a route or Custom Domain and `workers_dev` is `false`. See [Cloudflare Access](#cloudflare-access).                                                                  |

Grant **Workers → Admin** for the account when Void creates the Worker. For subsequent deploys, **Workers → Editor** is enough for the Worker itself. Add **Workers Routes Write** for each zone where the deploy adds, updates, or removes a route or Custom Domain. Grant access to any resources Void reads or provisions, such as D1 or KV. See [Cloudflare Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/).

For email, run `void email setup --platform cloudflare` locally, commit `void.lock.json`, and pass `--require-email` in CI. The token also needs Zone Read and Email Sending Edit, plus Email Routing Edit for apps with `email/` handlers.

#### Cloudflare Access

For local deployment to an Access-protected Worker, you can use a short-lived user session:

```sh
export CF_ACCESS_TOKEN="$(cloudflared access token --app=https://<worker>.<account>.workers.dev)"
```

Void uses Access credentials for readiness checks without saving them. If checks are denied, the deployment fails. A first-deploy bootstrap can already be active behind Access when this happens.

By default, Void sends Access credentials only to `workers.dev` URLs. If `workers_dev` is `false`, Void can check readiness through your first route or Custom Domain. To send the credentials there, set `CF_ACCESS_READINESS_ORIGIN` to that hostname's origin:

```sh
export CF_ACCESS_READINESS_ORIGIN="https://app.example.com"
```

Set this variable in the shell or CI environment running `void deploy`. Use an exact HTTPS origin for a hostname you control that serves this Worker; Void sends your Access credentials there.

### Pull request previews

Give each pull request its own URL with [Cloudflare Previews](https://developers.cloudflare.com/workers/previews/). A preview belongs to the same Worker but never receives production traffic.

```sh
void deploy --platform cloudflare --preview pr-64 --json        # create or update
void project preview delete pr-64 --platform cloudflare         # remove
```

Deploy production once first and set the Worker name (`cloudflare.name`, or `name` in `wrangler.jsonc`). The token needs **Workers → Editor**, since the Worker already exists, and `CLOUDFLARE_ACCOUNT_ID` pins the account. The preview job runs the pull request's code with this token, which can also deploy production. Pull requests from forks and Dependabot get no preview.

This workflow deploys a preview on every push, comments its URL once, and deletes it when the pull request closes:

```yaml
name: Preview
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: ${{ github.workflow }}-pr-${{ github.event.pull_request.number }}
  # A new push cancels an older preview deploy; cleanup waits for it instead.
  cancel-in-progress: ${{ github.event.action != 'closed' }}
jobs:
  deploy:
    # Fork and Dependabot pull requests get no repository secrets.
    if: >-
      github.event.action != 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v5
      - uses: actions/setup-node@v6
        with: { node-version: lts/*, check-latest: true, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - id: preview
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PREVIEW: pr-${{ github.event.pull_request.number }}
        run: |
          pnpm exec void deploy --platform cloudflare --preview "$PREVIEW" --json > preview.json
          echo "url=$(jq -er .previewUrl preview.json)" >> "$GITHUB_OUTPUT"
      # The preview URL never changes for a pull request, so comment once.
      - env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
          URL: ${{ steps.preview.outputs.url }}
        run: |
          if ! gh pr view "$PR" --json comments --jq '.comments[].body' | grep -qF "$URL"; then
            gh pr comment "$PR" --body "Preview: $URL"
          fi
  cleanup:
    if: >-
      github.event.action == 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      # Trusted base-branch code; it still exists after the pull request closes.
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - uses: pnpm/action-setup@v5
      - uses: actions/setup-node@v6
        with: { node-version: lts/*, check-latest: true, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PREVIEW: pr-${{ github.event.pull_request.number }}
        run: pnpm exec void project preview delete "$PREVIEW" --platform cloudflare
```

Using npm, Yarn or Bun? Use the setup steps that `void init --github` writes. If an earlier job builds the site, download its output and add `--skip-build`. Preview URLs are public; see [`void deploy --preview`](../reference/cli/deploy.md#void-deploy-preview) for the JSON output, naming rules and limits.

### Databases and secrets

For PostgreSQL and MySQL, supply `DATABASE_URL` to the deploy process. Void uses it for Hyperdrive and migrations without writing it to config. MySQL schema changes can partially apply before an error; see [failed MySQL migrations](../guide/database/mysql.md#failed-migrations).

Creating Hyperdrive requires an API token with Hyperdrive edit permission. Alternatively, create it in Cloudflare and add its ID to `cloudflare.hyperdrive`; an existing binding works with browser login.

Run `void db generate` and commit migrations before deploying schema changes. This includes Better Auth tables. Custom D1 migration directories, tables, and patterns are supported; deploy stops if the files to apply differ from the validated history.

Set production server values with `void secret put <NAME>`. Void preserves existing remote secrets and creates `BETTER_AUTH_SECRET` when an auth app needs one. Local `.env` values are never deployed.

### Readiness and rollback

Void checks an uploaded version before sending it traffic. If the Worker has no public URL, because workers.dev is off and no route or Custom Domain is configured, Void activates it without a readiness check.

If readiness or trigger updates fail, Void restores the previous deployment. If trigger updates fail and the previous triggers can't be restored, such as after another tool's deployment or from an empty draft, the new version stays live. The error names the version serving traffic.

Finish or cancel gradual rollouts in Cloudflare before deploying through Void.

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

Void restores recorded triggers along with the code. Versions without a complete trigger snapshot keep current routes and schedules. Database recovery is separate: use [`void db restore`](../reference/cli/database.md#void-db-restore) to undo D1 migrations.

#### Clear a deployment with a candidate at 0%

A failed deploy can leave the live version at 100% and a candidate at 0%.

1. Pause other deploys and let any in progress finish. In the Cloudflare dashboard, select the account and Worker named in the error, then open **Deployments**.
2. Confirm **Active Deployment** still shows the exact versions and percentages Void reported. Continue only if the 0% version is unused, including by version overrides.
3. Select **Rollback** on the live version. [Cloudflare's split deployment rollback guide](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#rolling-back-from-a-split-deployment)

Retry when **Active Deployment** lists only the live version. If Void still reports the pair, wait and retry.

Cloudflare can reject a rollback after a secret change (error `10220`).

A newer inactive upload can still block a first link or a static deploy that inherits secrets after rollback. If Void reports a version-history or secret inheritance error, inspect the active and latest Worker versions in Cloudflare before retrying.

#### Scope and limitations

Void deploys native apps, static sites, SPAs, supported SSGs, and Cloudflare builds from TanStack Start, React Router, SvelteKit, Nuxt, Analog, and Astro. The vinext adapters are experimental.

- Native apps support Void routing rules. Framework apps on the direct target must configure redirects, rewrites, fallbacks, and headers through their framework or Worker.
- `--skip-build` works for existing static output. Worker apps require a fresh build.
- `--preview` works for static sites and SPAs only.
- Named Cloudflare environments aren't supported. Use a separate Void project config for each target.
- Sandbox requires Workers Paid and Docker. See [Sandbox requirements](../guide/sandboxes.md#deployment) for plan and token permissions.
- Email to arbitrary recipients, and all sending from apps without `email/` handlers, requires Workers Paid. Apps with handlers keep inbound mail and verified recipients on Workers Free. See [Email](../guide/email/domains.md#your-own-cloudflare-account).
- Node.js, Bun, and Deno use their [own deployment path](./nodejs-bun-deno.md).

Commit Durable Object migration history in `void.lock.json`. Do not delete or reorder deployed steps.

### Managing the deployed app

`void secret`, `void domain`, `void project status|list|logs|rollback`, `void project preview delete`, and remote `void db` commands use the selected account and Worker. Logs are a live tail.

Custom domain commands update routes immediately. If a first deployment times out while DNS or TLS is propagating, check the domain in Cloudflare and retry once `/__void/ready` is reachable.

`void project delete` does not remove Cloudflare resources. Review ownership and remove them in Cloudflare.

### Local development

Local D1, KV, and R2 bindings use local data. Your production resource IDs are used during deployment.

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

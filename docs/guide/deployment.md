---
outline: deep
---

# Deployment

`void deploy` builds your app, provisions resources, applies migrations, and deploys it. Choose your own Cloudflare account or a Void platform run by your team.

After a successful deployment, Void prints your deployment URL in a summary box with the details reported by your deployment target.

## Deploy to Cloudflare

Choose Cloudflare during `void init`, or connect later:

```sh
void connect --platform cloudflare
void deploy --platform cloudflare
```

Void opens your browser to sign in and asks which account to use. Later deploys use the saved target, so you can run `void deploy`.

Native apps work on Workers Free within its quotas. [Sandboxes](./sandboxes.md#requirements) require Workers Paid and Containers access. See the [Cloudflare guide](../integrations/cloudflare.md) for configuration, token permissions, and features with additional requirements.

If you already have a Worker and a root `wrangler.jsonc` or `wrangler.json`, `void deploy` can link it and preserve its resources. See [Deploy an existing Worker](../integrations/cloudflare.md#deploy-an-existing-worker).

## Prepare your app

### Migrations

Deploy applies pending SQL migrations from `db/migrations/`. If your schema has changes without a migration, deploy stops:

```sh
void db generate
```

Review and commit the SQL, then deploy again. Rollback does not reverse database migrations. See [Database](./database.md) for the local workflow.

On your own Cloudflare account, deploy saves a D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) restore point before it applies pending migrations and prints the [`void db restore`](../reference/cli/database.md#void-db-restore) command for it. If no restore point can be saved, deploy stops before it migrates. If deploy fails after it applied the migrations, for example when the upload fails, it prints the command again. Usually you fix the error and deploy again; restore only if the live version cannot run against the new schema. To recover from a bad migration, roll back the code with `void project rollback` if the new version is live, restore the database, then fix or remove the migration before you deploy again. After a one-off `void deploy --platform cloudflare`, add `--platform cloudflare` to each of these commands. Restoring discards every write made after the restore point. Restore points expire after 7 days on Workers Free and 30 days on Workers Paid; after that, undo a migration with a new one.

### Environment variables

Declare values in `env.ts` and set production server secrets with `void secret put`. Deploy never uploads your local `.env`. Supply public `VITE_*` values through the build environment. See [Environment Variables](./env-vars.md).

Keep the CLI and framework adapters on matching versions, and commit `void.config.ts` and `void.lock.json` when generated.

## Deploy from GitHub {#github}

Generate a workflow for your saved target and package manager:

```sh
void init --github
```

For Cloudflare, add `CLOUDFLARE_API_TOKEN` to your repository secrets. The token needs access to the account and products your app uses. PostgreSQL and MySQL apps also need `DATABASE_URL`.

Follow the [Cloudflare CI setup](../integrations/cloudflare.md#deploying-from-ci) for Worker preview URLs and Cloudflare Access credentials.

### Team platform CI

For a core self-hosted platform, use your own workflow with a [project deploy token](./platform/installation/first-deployment.md). Set `VOID_TOKEN`, `VOID_API_URL`, and the project slug, then connect in each fresh CI environment:

```sh
void connect "$VOID_API_URL" --no-login
void deploy --platform void --project "$VOID_PROJECT"
```

Platforms with the optional GitHub Actions integration use short-lived OIDC credentials. Authorize the repository with `void github connect <project> --repo <owner/repo> --executor github_actions`, set the repository's `VOID_API_URL`, and keep `permissions: id-token: write` in the generated workflow.

If your platform supports managed GitHub builds, the GitHub App can deploy on push without a workflow file. See [GitHub commands](../reference/cli/github.md#github) to install the App and connect your repository.

If CI runs typechecking before deploy, run `void prepare` after installing dependencies to generate the `.void/` types.

## Deploy to a team platform

Use the API URL from your administrator. In a new or unlinked app:

```sh
void connect platform.example.com
void deploy --platform void --project my-app
```

Sign in and confirm project creation when asked. To use an existing project, run `void project link`. Later deploys use the saved destination.

Project owners can [share access](./project-collaboration.md). To install a platform for your team, start with [Install a Void Platform](./self-hosted-platform.md), which also compares the deployment features of both targets.

### Deploy to another Void platform

For a single deployment to a different platform, connect and name its project:

```sh
void connect second.example.com
VOID_API_URL=https://second.example.com void deploy --platform void --project my-app
```

This keeps your saved destination. Each platform has its own projects, secrets, and data. See the [CLI reference](../reference/cli/deploy.md) for target selection and other flags.

## Logs and rollback

Inspect your deployment, read runtime logs, or select a previous deployment:

```sh
void project status
void project logs
void project rollback
```

Cloudflare logs use a live tail; team platforms retain log history. Before rolling back, check that the earlier code works with your current database schema. See [Project commands](../reference/cli/project.md).

## Other runtimes

Build a standalone server for [Node.js, Bun, or Deno](../integrations/nodejs-bun-deno.md) using the `target` setting. Deploy `dist/ssr` and `dist/client` together using your own hosting. Cloudflare bindings such as D1, KV, R2, and Workers AI are unavailable on these targets.

## Usage and execution limit pages

Team platforms return a structured HTTP 429 to API and Pages action requests when an app exceeds its request or CPU allowance. Browser requests get an error page.

To customize it, add `public/usage-limit.html` for request limits or `public/execution-limit.html` for execution limits. Use standalone HTML with inline CSS and data-URL images. Scripts, external assets, and form submissions are disabled. Missing custom pages use the built-in page.

Responses are not cached. A streaming response that has already started cannot be replaced with an error page; handle stream failures in your UI.

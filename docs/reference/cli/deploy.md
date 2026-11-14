---
description: 'Build an app, provision its resources, apply migrations, and publish it.'
outline: deep
---

# Deployment {#deploy}

## `void deploy` {#void-deploy}

```
void deploy [--project <name>] [--dir <path>] [--spa] [--skip-build] [--skip-migrations] [--debug]
void deploy [--platform <cloudflare|void>] [--require-email]
void deploy --platform cloudflare --atomic
void deploy --platform cloudflare --provision
void deploy --platform cloudflare --preview <name> [--json]
```

Auto-detects your project type and chooses the right pipeline. See [Supported App Types](../../guide/app-types.md) and [Deployment](../../guide/deployment.md) for details.

Deploying to a Void platform requires an explicit connection with `void connect <url>`.
A saved project URL or `VOID_API_URL` alone does not establish a connection.
In fresh CI environments, run `void connect "$VOID_API_URL" --no-login` first.

On a Void platform, an accepted deployment continues if the CLI disconnects. The CLI automatically reconnects to its progress. Pressing Ctrl+C stops observation; use `void project cancel` to request cancellation and `void project status` to inspect the result. If interrupted execution requires recovery, wait for its result before deploying again.

The CLI reports stalled progress and automatic recovery, and waits up to 30 minutes after acceptance. If it times out, the deployment can continue; check `void project status` before trying another deployment.

For an existing Void Worker, `void deploy` can link the Worker and migrate its root Cloudflare config. Keep the first deployment focused on the existing app. See [Deploy an existing Worker](../../integrations/cloudflare.md#deploy-an-existing-worker) for requirements and the ISR cache choice.

For Drizzle projects, deploy performs a read-only schema drift check. If a new migration would be generated, deploy stops and tells you to run `void db generate`, review the migration, commit it yourself, and rerun `void deploy`.

| Flag                            | Purpose                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--platform <cloudflare\|void>` | Override the platform stored in `.void/project.json`                                                                                                                 |
| `--project <name>`              | Target a specific Void project by slug; not supported with `--platform cloudflare`                                                                                   |
| `--dir <path>`                  | Deploy a pre-built static directory (skips build)                                                                                                                    |
| `--spa`                         | Use SPA mode instead of SSG for static deploys                                                                                                                       |
| `--skip-build`                  | Skip the build step; on Cloudflare this is supported for static/SPA/SSG deploys only                                                                                 |
| `--skip-migrations`             | Deploy without applying application or authentication SQL migrations; supported on Cloudflare and Void platforms                                                     |
| `--require-email`               | Fail when email cannot be set up instead of deploying without it; requires `--platform cloudflare`                                                                   |
| `--provision`                   | Run resource provisioning again even when every resource exists, for example to enable D1 read replication on an existing database; requires `--platform cloudflare` |
| `--atomic`                      | Publish an existing Durable Object Worker directly; readiness is checked after traffic changes                                                                       |
| `--preview <name>`              | Create or update a Cloudflare Preview instead of production; see [Previews](#void-deploy-preview)                                                                    |
| `--json`                        | With `--preview`, print the result as one JSON record on stdout; progress goes to stderr                                                                             |
| `--debug`                       | Mirror the structured deploy log to stderr (also written to `~/.void/logs/`)                                                                                         |

`--atomic` applies to one deployment. For an existing Durable Object Worker that consistently cannot stage, set `deploy: { cloudflare: { mode: 'atomic' } }` in `void.config.ts` so plain `void deploy` uses atomic publication. The default is `staged`.

Use `--skip-migrations` when you run migrations separately or share a database with a preview. The code must work with the database's current schema. The next deploy without this flag applies pending migrations.

Keep migration files and schema validation in place. This option skips application and authentication SQL; Durable Object class migrations still run when publishing code. If a Void platform doesn't support the flag, upgrade it first.

Every deploy writes a JSONL log to `~/.void/logs/`. Failures print the log path and relevant details. Use `--debug` or `VOID_DEPLOY_DEBUG=1` to mirror it to stderr.

Keep credentials out of build commands and register them as CI secrets so your CI provider can mask them in logs.

Platform resolution precedence:

1. `--platform <cloudflare|void>`
2. `platform` in `.void/project.json`
3. Void for projects initialized by an older SDK without a saved platform

Selecting Skip deployment setup stores `"platform": "none"`; a later `void deploy` stops with guidance until a platform override is provided.

For the Void platform, project resolution precedence is:

1. `--project <name>`
2. `VOID_PROJECT`
3. linked project in `.void/project.json`

If no project is linked and no override is provided, CLI prompts to link or create one. In CI (non-TTY), `void deploy` errors out instead — set `VOID_PROJECT` or pass `--project <slug>`.

To deploy to another connected Void platform for one invocation:

```sh
void connect second.example.com
VOID_API_URL=https://second.example.com void deploy --platform void --project my-app
```

`VOID_API_URL` selects the platform and `--project` selects its project. You must
name the project when overriding a different platform's saved link. Existing
project links and deployment preferences remain unchanged, even when the target
project is created. The same applies to `VOID_PROJECT` and to another project on
the current platform. A first deployment still links the project when no destination
is configured. See [Deploy to another Void platform](../../guide/deployment.md#deploy-to-another-void-platform).

## `void deploy --platform cloudflare` {#void-deploy-platform-cloudflare}

Build and deploy to your Cloudflare account using `void.config.ts`:

```sh
void deploy --platform cloudflare
void deploy --platform cloudflare --require-email   # fail instead of deploying without email
```

Void signs you in through your browser when needed and saves the selected account. In CI, set `CLOUDFLARE_API_TOKEN` and, if the token can access several accounts, `CLOUDFLARE_ACCOUNT_ID`.

| Option or setting              | Cloudflare behavior                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dir`, `--spa`               | Deploy static output through a small Worker and Workers Assets                                                                                |
| `--skip-build`                 | Reuse existing static, SPA, or SSG output; unavailable for Worker apps                                                                        |
| `--skip-migrations`            | Skip database migrations; existing PostgreSQL/MySQL Hyperdrive bindings do not require `DATABASE_URL` just to skip SQL                        |
| `--project`                    | Unavailable; the Worker and account come from `void.config.ts` and `void.lock.json`                                                           |
| Named environments             | Unavailable; use the top-level `cloudflare` config                                                                                            |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | Needed in fresh CI when a workers.dev Worker has no preview URL; cached locally after a deploy. It does not apply when `workers_dev` is false |
| `CF_ACCESS_READINESS_ORIGIN`   | Lets Access credentials reach the readiness check on a route or Custom Domain, for example `https://app.example.com`                          |
| `--require-email`              | Fail instead of deploying without email when the email step cannot run, as in CI                                                              |
| `DATABASE_URL`                 | Required in the deploy environment for PostgreSQL or MySQL provisioning and migrations                                                        |

After `--skip-migrations`, direct Cloudflare deployment history shows the applied migration state as unknown. Rolling back code doesn't reverse database changes.

The token needs Workers Scripts: Edit, read access to bound resources, and edit access to products Void provisions. Commit `void.lock.json` after the first deploy before using other machines or CI.

Use `void secret put <NAME>` for production server values. Local `.env` values are never deployed. Run `void db generate` and commit schema changes before deploying.

Sandbox requires [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans), Docker, and Containers access. API tokens need Account / Containers: Edit and Account / Cloudchamber: Edit.

For email, set `email.from` and run `void email setup --platform cloudflare` locally. Commit the lock file and pass `--require-email` in CI. See [Email setup](../../guide/email/domains.md#your-own-cloudflare-account).

For Access credentials, Hyperdrive permissions, readiness, and rollback, see [Cloudflare deployment](../../integrations/cloudflare.md#deploy-to-your-own-cloudflare-account).

## `void deploy --platform cloudflare --preview <name>` {#void-deploy-preview}

Deploy the build to a named [Cloudflare Preview](https://developers.cloudflare.com/workers/previews/) of the same Worker:

```sh
void deploy --platform cloudflare --skip-build --preview pr-64 --json
```

A Preview has its own stable URL, `https://<name>-<worker>.<subdomain>.workers.dev`, which always serves its latest deployment. Deploying the same name again updates that URL. Production traffic, the active deployment, routes and schedules are unchanged.

Previews are available for static sites, SPAs and supported SSGs. Apps that need a Worker, such as server routes, bindings, migrations or secrets, are refused before anything is built or uploaded. A Preview does not inherit production secrets.

The name uses lowercase letters, digits and hyphens. `<name>-<worker>` must fit in 63 characters. Use a name derived from the pull request, such as `pr-64`, rather than a branch name.

With `--json`, stdout carries one line:

```json
{
  "workerName": "my-app",
  "previewName": "pr-64",
  "previewUrl": "https://pr-64-my-app.my-team.workers.dev",
  "deploymentId": "…",
  "deploymentUrl": "https://…-my-app.my-team.workers.dev"
}
```

`previewUrl` always serves the latest deployment of this Preview. `deploymentUrl` serves only this deployment.

The Worker must allow Preview URLs. Void's production deploy turns them on when workers.dev is on. If you set `cloudflare.preview_urls` to `false` in `void.config.ts`, a preview deploy fails and says how to turn it back on. Workers Free allows 100 Previews per Worker; Cloudflare removes the least recently deployed one beyond that.

See [Pull request previews](../../integrations/cloudflare.md#pull-request-previews) for a GitHub Actions workflow.

## `void preview delete <name>` {#void-preview-delete}

```sh
void preview delete pr-64
```

Delete a Preview and all its deployments. Production is unchanged. Deleting a Preview that does not exist succeeds, so a cleanup job can run more than once. It uses the same account and Worker as `void deploy --platform cloudflare`.

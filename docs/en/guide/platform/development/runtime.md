---
outline: deep
---

# Runtime and Source Builds

## Deploying Your Runtime

Build the runtime. From a Git checkout, the build automatically records the current commit in the runtime manifest. An uncommitted checkout is recorded with a `-dirty` suffix:

```sh
vp run build:core
```

Build systems may set `VOID_PLATFORM_SOURCE_REVISION` when they need to override automatic detection with another immutable revision. A source archive without Git metadata builds normally but leaves the revision unrecorded.

The runtime is written to `packages/platform/dist/runtime`. Use the built CLI to preview a new installation from those files:

```sh
void-dev platform install \
  --name my-team \
  --application-domain example.app \
  --zone example.app \
  --runtime packages/platform/dist/runtime \
  --plan
```

Before applying the plan, complete the [installation guides](/guide/self-hosted-platform). Run the command without `--plan` to install. For testing before your domain is ready, replace `--application-domain` and `--zone` with `--workers-dev`; PostgreSQL and the runtime, login-provider, and R2 credentials are still needed. Use `void-dev` in place of `void` and keep `--runtime packages/platform/dist/runtime` on install and resume commands. For an interrupted installation, keep that runtime build available until it completes.

Later, run `void-dev platform domain set example.app`. Domain setup uses the existing installed runtime and needs no `--runtime`, rebuild, or app redeploy. It keeps the platform API URL and original workers.dev app URLs available.

For an existing installation, preview an upgrade using its connection ID:

```sh
void-dev platform upgrade <installation-id> \
  --runtime packages/platform/dist/runtime --plan
```

Then run it without `--plan` to apply the upgrade. Source-built runtimes go through the same artifact, database, ownership, and health checks as released runtimes. The CLI preserves a disabled installation's state and records the source revision in its installation checkpoint.

## Optional GitHub Webhook Ingress for Access-Protected APIs

The core installer does not deploy the dashboard, GitHub App, build Containers,
or webhook ingress. Passing a source build with `--runtime` does not provision
their infrastructure, bindings, credentials, or platform capabilities. The
repository's hosted deployment scripts target Void Cloud; they are not a
general setup procedure for adding these services to a self-hosted platform.
Use the core CLI deployment workflow unless your fork supplies and maintains
that optional integration.

If your fork has added managed GitHub builds and Cloudflare Access protects its API hostname, GitHub cannot deliver directly
to `/webhooks/github`: GitHub does not present your Access credentials. Do not add
an Everyone or bypass policy to the API application.

Deploy the optional webhook ingress at a separate public hostname. It accepts signed GitHub deliveries at `POST /github` and forwards them to your API through a service binding. Without Access protection, use the API’s `/webhooks/github` endpoint directly.

To deploy the optional ingress:

1. Provision the GitHub App, build executors, API bindings, credentials, and
   managed-build capability in your fork, then deploy its source API runtime
   with the internal operation. A core install or upgrade alone does not add
   managed builds.
2. Edit `platform/packages/api/wrangler.github-webhook-ingress.jsonc`. Give the
   ingress a name unique to the installation and set its `API` service binding to
   the exact installed API Worker name. Keep its public hostname separate from
   every human/API hostname covered by Access.
3. Deploy it from the repository root:

   ```sh
   vp run --filter @voidcloud/api deploy:github-webhook-ingress --env production
   ```

   Use `--env staging` for the staging entries in the same config.

4. In the Cloudflare dashboard, add encrypted Worker secrets. Set the GitHub
   App's existing `GITHUB_WEBHOOK_SECRET` on both the API and ingress Workers.
   Generate a separate high-entropy value, such as `openssl rand -base64 32`,
   and set it as `GITHUB_WEBHOOK_INGRESS_SECRET` on both Workers. Do not reuse a
   platform management, JWT, Access, or GitHub webhook credential for that value.
5. In the GitHub App settings, keep **Content type** set to `application/json`,
   keep the same webhook secret, and change **Webhook URL** to the isolated
   ingress URL ending in `/github`. Use GitHub's test delivery and confirm a 2xx
   response before relying on push builds.

The ingress accepts payloads up to 25 MiB. See [GitHub’s payload limit](https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap).

## Deploying Source Builds from CI

Build `@void/platform` from your checkout and pass its runtime directory to `install`, `upgrade`, `repair`, `enable`, or `rollback` with `--runtime`. Custom runtimes get the same integrity, migration, health, and rollback checks as packaged releases.

Use a clean Git checkout or set `VOID_PLATFORM_SOURCE_REVISION` to identify the revision you deploy.

A fresh CI runner can discover the installation each time. Set `CLOUDFLARE_API_TOKEN` and `VOID_PLATFORM_DATABASE_URL` through its protected environment, then:

::: details CI commands and recovery inputs

```sh
vp run build:core

export VOID_PLATFORM_REGISTRY_DIR="$RUNNER_TEMP/void-platform-registry"
export VOID_PLATFORM_RECOVERY_KEY="$(openssl rand -base64 32)"
node packages/void/dist/cli/cli.mjs platform discover --account "$CLOUDFLARE_ACCOUNT_ID" \
  --installation "$VOID_PLATFORM_INSTALLATION"
node packages/void/dist/cli/cli.mjs platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --plan
node packages/void/dist/cli/cli.mjs platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --yes
```

Omit the installation selector only if the account has one discoverable installation. Run one deployment per installation at a time, and let it finish before starting the next. Cancelling during migrations or Worker rollout can leave an installation waiting for recovery.

Keep the management token, database URL, JWT signing secret, email signing secret for email-enabled installations, and complete project-encryption keyring in a protected CI environment. Upgrades inherit deployed Worker secrets. The original values are needed when recreating a missing Worker; configuration credentials are also needed when explicitly rotating them.

:::

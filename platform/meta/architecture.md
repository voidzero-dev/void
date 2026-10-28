# Platform architecture

The Void platform runs in an operator's Cloudflare account. Developers connect
the CLI to that installation, sign in, and deploy applications into its Workers
for Platforms namespace. Each installation owns its resources and its
PostgreSQL database.

For installation steps and the supported feature set, read
[Self-host a Void platform](../../docs/en/guide/self-hosted-platform.md). For
administration commands, read
[Platform Administration](../../docs/en/guide/platform-administration.md).

## Source and packaged runtime

The framework, CLI, and platform share one workspace:

| Directory                                            | Responsibility                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `packages/void`                                      | Vite plugin, application runtime, and `void` CLI                |
| `packages/platform`                                  | Installation contracts and packaged core Worker bundles         |
| `packages/deploy-core`, `packages/deploy-cloudflare` | Deployment contracts and Cloudflare upload primitives           |
| `packages/edge`, `packages/isr`                      | Shared routing and ISR behavior                                 |
| `platform/packages/api`                              | Control plane, provisioning, administrator API and UI           |
| `platform/packages/dispatch`                         | Application ingress, asset serving, queue delivery and metering |
| `platform/packages/proxy`                            | Workers AI, remote bindings and ISR revalidation                |
| `platform/packages/email-gateway`                    | Email ingress, route checks and bounded tenant delivery         |
| `platform/packages/tail`                             | Runtime log ingestion into Analytics Engine                     |
| `platform/packages/dashboard`                        | User dashboard and its local UI components, styles and assets   |

The installer consumes integrity-checked runtime artifacts from
[`@void/platform`](../../packages/platform/README.md). It generates resource
names, bindings and hostnames for the selected installation. A fork can build
that same runtime from its own source and supply it to `void platform upgrade`.

The user dashboard and integrations such as managed GitHub builds remain in
the repository, but are not included in the core installation. Their presence
in the source tree does not imply that an installation supports them. The
platform's discovery document advertises its capabilities.

## Request and deployment flow

```text
Developer                       Installed platform
---------                       ------------------
void connect <url>       ------> Discovery document
void auth login         ------> API + enabled login provider
void deploy             ------> API
                                 | validate manifest and provision resources
                                 | upload worker and assets; run migrations
                                 | publish active routing record
                                 v
Browser ---------------------> Dispatch
                                 |----> Worker in dispatch namespace
                                 |----> Static assets in KV/R2
                                 `----> Request metering

Application worker ----------> Proxy (AI, remote bindings, revalidation)
Inbound email ---------------> Email gateway -> API route check -> Application worker
Application tail events -----> Tail -> Analytics Engine -> API log queries
void platform user list ------> Administrator API
```

The API stages deployments before changing the active routing record. Worker
deployments apply migrations before traffic moves. Static deployments publish
an asset manifest without creating an application Worker. Retained deployments
allow rollback within the installation's configured limits.

Worker assets use Cloudflare's asset binding, with a platform-owned KV/R2 mirror
for the known missing-asset response described in
[the asset fallback design](./design-docs/0066-wfp-asset-r2-fallback.md).

## Data and trust boundaries

PostgreSQL, reached through Hyperdrive, stores users, projects, deployments,
resource ownership, administrator sessions and audit records. Routing KV points
application hostnames to active deployments. KV/R2 store static assets;
Analytics Engine stores usage and runtime logs. Durable Objects coordinate
stateful work such as cron scheduling and usage counters. The optional managed
build subsystem keeps build logs in Durable Object SQLite storage, separately
from application runtime logs.

Application D1, KV, R2 and Queue resources are provisioned separately from the
platform's own stores. Public SDK packages under `packages/` must not import
platform implementation code. Shared contracts belong in the public packages.

Lifecycle commands authenticate the operator to Cloudflare. Day-to-day
administration uses installation-scoped administrator credentials. The running
platform has its own runtime token for resource provisioning. These credentials
serve different purposes and must not be substituted for one another.

See [operations](./operations.md) for maintenance and
[the design archive](./design-docs/README.md) for the reasoning behind individual
features. Archived proposals describe the source at the time they were written;
they are not an installation checklist.

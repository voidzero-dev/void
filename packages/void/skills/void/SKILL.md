---
name: void
description: Build Void apps and use the Void CLI by loading the relevant bundled guides and references.
---

# Void

Read only the guides needed for the user's task. Prefer the app's installed
documentation at `node_modules/void/docs/` so it matches the app's Void version.
All `docs/` paths below are relative to that package's root. When using this
skill globally without a local Void installation, follow the skill's symlink to
its real directory and use `../../docs/` in the same Void package. If the skill
was copied without the package, use the guides at [https://void.cloud](https://void.cloud) instead.

Before running a Void command, find its group in `docs/reference/cli.md`, then
read the matching page under `docs/reference/cli/` for syntax, options, and
deployment target. Use Void commands for application and platform
workflows. Mention Wrangler only when the user needs to recognize a literal
configuration file or environment variable.

Use `void` and `@void/*` in imports, examples, and package manifests. Follow the
project's existing framework and deployment destination. Deploying to a Void
platform requires an explicit `void connect <url>` first; never infer a platform
from old examples, tokens, or project IDs.
Platform hostnames passed to `void connect` default to HTTPS. Loopback hosts
(`localhost`, `127.0.0.1`, and `[::1]`) default to HTTP: `void connect localhost:8787`.
An explicit scheme overrides the default.
For a one-time deployment elsewhere, connect to that platform, then set
`VOID_API_URL` for the deploy command and pass `--project <slug>`. This preserves
the app's existing saved destination, including when the target project is new.

## Task Routing

| User intent                                  | Docs file(s)                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| CLI command syntax, flags, env vars          | `docs/reference/cli.md`                                                                   |
| Initial setup, onboarding, first app         | `docs/guide/quickstart.md`, `docs/reference/cli/setup.md`                                 |
| App type detection and mode behavior         | `docs/guide/app-types.md`, `docs/reference/config.md`                                     |
| Server/API routing and middleware            | `docs/guide/server-routing.md`, `docs/integrations/hono.md`                               |
| Pages mode, loader/action, forms, layouts    | `docs/guide/pages-routing/*.md`, `docs/guide/type-safety.md`                              |
| Database and migrations                      | `docs/guide/database.md`, `docs/guide/type-safety.md`                                     |
| Typed fetch and end-to-end typing            | `docs/guide/typed-fetch.md`, `docs/guide/type-safety.md`                                  |
| Authentication                               | `docs/guide/auth.md`, `docs/guide/env-vars.md`                                            |
| Cloudflare runtime bindings and config       | `docs/integrations/cloudflare.md`, `docs/reference/config.md`, `docs/guide/env-vars.md`   |
| AI inference (Workers AI, providers)         | `docs/guide/ai.md`                                                                        |
| Images, `Image`, `getImageProps`, next/image | `docs/guide/images.md`, `docs/reference/config.md`                                        |
| Durable State and WebSockets                 | `docs/guide/durable-state.md`, `docs/guide/websockets.md`                                 |
| Server-sent events and live streams          | `docs/guide/sse.md`, `docs/guide/live.md`                                                 |
| Sandboxes                                    | `docs/guide/sandboxes.md`                                                                 |
| Email                                        | `docs/guide/email.md`, then the matching guide under `docs/guide/email/`                  |
| KV / storage / queues / cron jobs            | `docs/guide/kv.md`, `docs/guide/storage.md`, `docs/guide/queues.md`, `docs/guide/jobs.md` |
| SSR and caching                              | `docs/guide/ssr.md`, `docs/guide/edge/*.md`                                               |
| Rewrites, redirects, fallbacks               | `docs/guide/edge/rewrites.md`, `docs/guide/edge/redirects.md`, `docs/reference/config.md` |
| Static site generation                       | `docs/guide/ssg.md`                                                                       |
| Connected apps and artifact preparation      | `docs/guide/platform/administration/connected-apps.md`, `docs/reference/api/deploy.md`    |
| Deployment and CI                            | `docs/guide/deployment.md`, `docs/reference/cli/deploy.md`                                |
| Install or maintain a company platform       | `docs/guide/self-hosted-platform.md`, `docs/reference/cli/platform-installation.md`       |
| Develop or deploy a platform fork            | `docs/guide/platform-development.md`, `docs/guide/self-hosted-platform.md`                |
| Platform administration                      | `docs/guide/platform-administration.md`, `docs/reference/cli/platform.md`                 |
| Platform plans and account limits            | `docs/guide/platform/administration/plans.md`, `docs/reference/cli/platform-config.md`    |
| Self-host deploy to own Cloudflare account   | `docs/integrations/cloudflare.md`, `docs/reference/cli/deploy.md`                         |
| Project status, deployment history           | `docs/reference/cli/project.md`                                                           |
| Cache purging                                | `docs/reference/cli/project.md`                                                           |
| Project logs, runtime errors                 | `docs/reference/cli/project.md`                                                           |
| Secrets management (put/sync/delete)         | `docs/reference/cli/secrets.md`, `docs/guide/env-vars.md`                                 |
| Typed env vars (`defineEnv`, `env.ts`)       | `docs/guide/env-vars.md`                                                                  |
| Custom domain setup                          | `docs/reference/cli/domains.md`                                                           |
| Database status, reset, seed, export         | `docs/reference/cli/database.md`, `docs/guide/database.md`                                |
| Auth login/logout/whoami                     | `docs/reference/cli/auth.md`                                                              |
| Overview / introduction                      | `docs/guide/index.md`                                                                     |
| API surface details                          | `docs/reference/api.md`                                                                   |
| Meta framework integration                   | `docs/integrations/frameworks/*.md`                                                       |
| Coding agent setup                           | `docs/integrations/agents.md`                                                             |
| Node.js / Bun / Deno targets                 | `docs/integrations/nodejs-bun-deno.md`                                                    |
| ORMs and external databases                  | `docs/guide/database.md`                                                                  |
| Project structure and conventions            | `docs/reference/structure.md`                                                             |
| Resource/binding inference                   | `docs/reference/resource-inference.md`                                                    |

## Working rules

- Read the relevant guide before changing configuration, persistent resources,
  authentication, or deployment workflows. The guides define current behavior;
  avoid copying a second set of instructions into this skill.
- Before moving deployed Durable State, native Durable Object, or WebSocket definitions, read their
  guides and use `void info` to preserve resource names and instance keys.
- Declare application environment keys in `env.ts` and access them through
  `void/env`; follow `docs/guide/env-vars.md` for local and production values.
- For platform setup, follow the pages linked from
  `docs/guide/self-hosted-platform.md`. Use `void platform list` to find the
  installation slug for maintenance. For recovery, use its documented resume
  or repair workflow and preserve the installation's credentials and resources.
- Use `--plan` to review platform changes. If an operation has an uncertain
  outcome, inspect its status and events before retrying.

If the user invokes this skill without a task, inspect the app's local structure,
configuration, and saved deployment destination, give a brief status, and ask
what they want to work on.

Await AI and Sandbox operations normally. Usage limits reject with `UsageLimit` from `void/limits`; Void routes and Pages actions automatically return HTTP 429. Optionally catch with `instanceof UsageLimit` for a fallback or custom response. In Pages, prefer the adapter’s `Form` with `useForm()` so action failures remain visible and entered data is preserved. See `docs/guide/ai.md`, `docs/guide/sandboxes.md`, and `docs/guide/pages-routing/actions-and-forms.md`.

---
outline: deep
---

# Install a Void Platform

A Void platform lets your team deploy apps into a shared Cloudflare account. As an administrator, you install and maintain the platform. Developers connect the Void CLI to its URL, sign in through an enabled login method, and deploy their apps.

If you're deploying an app for yourself, [deploy directly to Cloudflare](/integrations/cloudflare#deploy-to-your-own-cloudflare-account). You don't need to install a platform first.

The core platform supports GitHub, Google, generic OIDC, and Cloudflare Access login, CLI deploys, D1, KV, R2, Queues, cron jobs, Workers AI, WebSockets, SSE, ISR, routing, logs, and rollback.

The core installation includes managed Sandboxes and an email gateway; email is enabled when you configure a shared mail domain and zone. The user dashboard, GitHub builds and webhooks, and build Containers aren't part of the core installation. [Project custom domains](/guide/platform/installation/domains#project-custom-domains) are opt-in with `--custom-domains`. Source-built platforms that add the optional GitHub services should follow the [isolated webhook ingress setup](/guide/platform/development/runtime#optional-github-webhook-ingress-for-access-protected-apis) when Access protects the API.

## Deployment features

Both targets use the same application APIs. A core platform adds shared access and retained deployment history:

| Feature                                          | Direct Cloudflare                | Core self-hosted platform                     |
| ------------------------------------------------ | -------------------------------- | --------------------------------------------- |
| Static sites, SPAs, and native Pages SSR         | Supported                        | Supported                                     |
| Routing rules, WebSockets, queues, cron, and ISR | Supported                        | Supported                                     |
| D1, KV, R2, and external SQL through Hyperdrive  | Supported                        | Supported                                     |
| Workers AI and provider requests                 | Your account and gateway         | Installation gateway and proxy                |
| Runtime logs                                     | Live Cloudflare tail             | Retained platform logs                        |
| Application rollback                             | Worker versions                  | Retained platform deployments                 |
| Typed Durable State and native Durable Objects   | Supported                        | Supported                                     |
| Sandboxes                                        | Requires Workers Paid and Docker | Requires Workers Paid on the platform account |
| Custom application domains                       | Supported                        | Unavailable in the core installation          |
| Generated GitHub deployment workflow             | Supported                        | Use your CI with a scoped developer token     |
| User dashboard and managed GitHub builds         | Not required                     | Not included in a standard installation       |

A team platform requires Workers for Platforms and the [documented infrastructure](/guide/platform/installation/domains#cloudflare-footprint). Features depend on the installation's configuration.

## Installation Guides

- [Prerequisites](/guide/platform/installation/prerequisites)
- [Credentials](/guide/platform/installation/credentials)
- [Install and Configure Login](/guide/platform/installation/setup)
- [First Deployment](/guide/platform/installation/first-deployment)
- [Domains and Resources](/guide/platform/installation/domains)
- [Maintenance and Recovery](/guide/platform/installation/maintenance)
- [Install from CI](/guide/platform/installation/ci)
- [Disable and Uninstall](/guide/platform/installation/uninstall)

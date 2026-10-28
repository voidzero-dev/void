# Design archive

These records explain implemented Void framework and platform decisions. Keep unresolved proposals, task lists, release signoff, commercial strategy, and private operational inventories outside this archive. Git history preserves earlier drafts and superseded approaches.

Start with maintained guides for current usage and operations:

- [Self-host a Void platform](../../../docs/en/guide/self-hosted-platform.md)
- [Platform Administration](../../../docs/en/guide/platform-administration.md)
- [Platform architecture](../architecture.md)
- [Platform development](../../README.md)
- [Release acceptance](../release-acceptance.md)

Public packages are under packages/ and platform implementations are under platform/packages/. These design records explain why the implementation takes its current shape; the linked source, tests, and maintained guides define exact behavior.

## Useful starting points

| Topic               | Records                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform data       | [PostgreSQL migration](./0015-platform-d1-to-planetscale.md), [secret storage](./0058-project-secret-storage-transition.md)                                                                                              |
| Builds and GitHub   | [Build service](./0010-builds.md), [implementation decisions](./0011-builds-implementation-plan.md), [identity linking](./0074-github-deploy-identity-linking.md), [build logs](./0076-build-logs.md)                    |
| Serving and routing | [Asset fallback](./0066-wfp-asset-r2-fallback.md), [direct R2 uploads](./0068-direct-r2-asset-upload.md), [scoped R2 migration](./0084-scoped-r2-asset-migration.md), [route-aware ISR](./0077-route-aware-isr-ttl.md)   |
| Custom domains      | [HTTP certificate validation](./0073-custom-domain-http-dcv-migration.md)                                                                                                                                                |
| Administration      | [Operator CLI](./0078-platform-operator-cli.md), [project teams and ownership transfer](./0080-project-teams.md), [project Zero Trust](./0083-project-zero-trust.md), [installation plans](./0090-installation-plans.md) |
| Email               | [Routing, recovery and delivery](./0078-email-cf-native.md)                                                                                                                                                              |
| Sandboxes           | [Managed Sandbox restoration](./0082-managed-sandbox-restoration.md)                                                                                                                                                     |

When a later decision changes behavior, update the relevant record and maintained guide. Remove superseded proposals from this directory once their final decision is captured.

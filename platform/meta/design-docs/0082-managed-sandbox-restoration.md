---
title: Managed Sandbox Restoration
status: implemented
---

# Managed Sandbox restoration

Managed Sandboxes on installed platforms run through a platform-owned Worker containing a fixed controller and pinned Cloudflare Sandbox SDK. Application code receives a restricted service interface. It does not receive the controller's Durable Object namespace, control-plane binding, or lifecycle hooks. Native Cloudflare deployments keep their separate SDK path.

The controller reserves concurrency before starting a container, records runtime only after confirmed startup, and releases it after confirmed shutdown. Durable generation identities fence stale lifecycle calls. Platform heartbeats enforce suspension and runtime budgets. Deployment, rollback, retention, cancellation, and project cleanup verify controller ownership; the earlier tenant-owned container drain remains an upgrade path for legacy installations.

See [controller provisioning](../../packages/api/src/provisioning/sandbox-controller.ts), [legacy drain](../../packages/api/src/sandbox-drain.ts), and the [Sandbox guide](../../../docs/en/guide/sandboxes.md). Live Containers acceptance remains part of the [release procedure](../release-acceptance.md).

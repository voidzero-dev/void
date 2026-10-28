---
title: Cloudflare-Native Email Design
status: implemented
---

# Cloudflare-native email

The repository implements two email hosting paths. Native Cloudflare deployments use the app's own send binding and email event. Platform deployments use a dedicated gateway for inbound mail, a proxy for sending, and PostgreSQL for policy, quotas, operations, and outcome records. The public programming model is void/email in both paths. Production enablement is a separate [release acceptance procedure](../release-acceptance.md#email-acceptance); this record describes the code present in the repository.

## Native deployment

The app's email.from setting selects the sender domain. Native deployment and void email setup/status share a credentialed Cloudflare preflight. Setup inspects routing, rules, Sending state, and configuration before changing account resources. It manages only the derived address rules and reports permission, DNS, or plan limits instead of assuming a Worker upload makes email ready. Apps without email use no email binding or entitlement probe. The [native setup implementation](../../../packages/void/src/cli/email-cloudflare.ts) owns this flow.

Native inbound handlers run on the Worker's email event. Native sending uses the configured binding. The local development inbox and test harness do not imply live delivery. See the [email guide](../../../docs/en/guide/email.md).

## Platform routing and trust

A zone has one ingress Worker, which serves explicitly registered mail domains. Shared project addresses and custom domains can coexist on a zone. A connection records the zone identity, credential scope, routing state, and domain assignments. The API claims and reconciles resources without adopting unrelated Cloudflare rules.

The gateway authenticates its connection, resolves a recipient against platform authority, and dispatches to the active project deployment using a signed, short-lived receipt. The tenant returns a bounded action response; each forward, reply, or rejection is validated before execution. The gateway and proxy keep email parsing and provider calls outside normal HTTP dispatch. The [connection service](../../../platform/packages/api/src/email/connection-service.ts), [gateway](../../../platform/packages/email-gateway/src/index.ts), and [tenant dispatch](../../../platform/packages/email-gateway/src/tenant-dispatch.ts) implement these boundaries.

## Provisioning and recovery

Domain setup and removal are durable operations with checkpoints for provider mutations. A reconciler resumes confirmed steps. An uncertain Cloudflare write is probed where possible; when read-back cannot prove the outcome, the operation blocks for explicit operator resolution instead of replaying the write. Secret rotation is staged and verified before retiring an old ingress credential. Inbound routing, outbound Sending, and management readiness are reported separately.

The [connection service](../../../platform/packages/api/src/email/connection-service.ts) persists these operations. [Platform operations](../operations.md#deployment-and-recovery) documents recovery actions.

## Admission and outcomes

For platform email, PostgreSQL is authoritative for project policy, suspension, verified recipients, quota reservations, and idempotency. Direct sends and inbound handler actions pass through that admission path. Provider acceptance and delivery are distinct outcomes. Failed and unknown attempts remain queryable; an unknown provider result is not silently retried with a new key. Metadata logs exclude message bodies and attachments.

The [admission service](../../../platform/packages/api/src/email/admission.ts), [proxy](../../../platform/packages/proxy/src/email.ts), and [email guide](../../../docs/en/guide/email.md) describe the implemented limits and public behavior.

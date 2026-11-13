---
title: Durable platform deployments
status: implemented
created: 2026-10-01
---

# Durable platform deployments

## Contract

The API admits a validated deployment under the existing project lock and stores
an operation receipt in PostgreSQL. Worker modules are staged in private R2
objects, checked by SHA-256 before execution, and removed after settlement.
Admission and its Queue outbox are one transaction. A missing Queue send or lost
acknowledgement is recovered by the two-minute scheduled outbox.

The CLI sends one idempotency key for its submission retries. The key is bound to
the actor, project, build and input digest. Replaying the same admitted input
returns the existing receipt; changing input with the same key is rejected.
The receipt names the operation, which survives static no-op placeholder deletion.
The final result can name an already-live deployment for a verified no-op.

The POST keeps its NDJSON progress interface and adds an operation receipt header.
The CLI follows that exact operation after a broken or stalled stream. Progress
is sequenced, bounded and authorized against current project access. A page is
terminal only after it contains the persisted terminal result. Observation does
not own execution; stopping observation does not cancel deployment.

The stream and resumed polling share one thirty-minute observation deadline.
Idle receipts report execution state, the last recorded progress, and the lease
expiry as an absolute UTC instant. Heartbeats do not imply forward progress.
The CLI reports a ninety-second progress stall once and announces recovery.
Staging smoke tests allow time for recovery and retain deployment JSONL logs
after success or failure.

Intermediate progress writes retry once and are best effort after that. A failed
progress write is logged without suppressing subsequent events or authoritative
terminal settlement. An acknowledgement lost after an intermediate write may
produce repeated progress; it never causes execution or application SQL to repeat.
Terminal journal failures still retain the recovery fence.

## Execution and recovery

An API Queue consumer claims an admitted operation once and executes the existing
deployment pipeline against its original placeholder and active-deployment
snapshot. It rechecks the actor, project, bound build and project deploy credential.
It preserves the existing cancellation, publication, project access, retention,
cutover and compensation fences. It does not perform fresh admission or allocate
a replacement deployment on redelivery.

[Queue consumers have a fifteen-minute wall-clock limit](https://developers.cloudflare.com/queues/platform/limits/).
An eighteen-minute lease, measured by PostgreSQL's clock, prevents takeover while
the original invocation can still run. The executor buffers terminal events until
the pipeline has finished and authoritative settlement is known. An unresolved
cutover remains pending even if the pipeline encountered an error.

Expired execution is reconciled rather than replayed. A committed deployment
returns success. An abandoned protected cutover restores the committed active
deployment through the existing recovery protocol. A failed candidate's private
Worker and serving artifacts must be confirmed removed before its recovery fence
is released. Application SQL and project-scoped resources are preserved. Unknown
cleanup outcomes remain pending and retry reconciliation; they do not authorize
another pipeline run. This deliberately avoids repeating SQL after a lost response.

## Installation boundary

The optional `deploymentExecution: 1` runtime contract installs the deployment
Queue, producer and fast scheduled outbox. Protocol-zero runtimes retain their
previous Worker configuration. The journal migration is additive.

New admission takes a shared lock on the installation lifecycle checkpoint in the
same transaction as its operation insert. A maintenance checkpoint closes admission;
admitted Queue work continues draining. Downgrading to a runtime without this
executor requires an authenticated drain proof after admission closes and before
changing Queue consumers or resources. Missing proof or pending operations blocks
the downgrade. This prevents retiring the executor while it owns work.

Recovery after hard invocation expiry is covered by automated integration tests;
the original live checks did not force a Queue invocation to expire. Recovery
waits for the eighteen-minute lease and never reruns application SQL.

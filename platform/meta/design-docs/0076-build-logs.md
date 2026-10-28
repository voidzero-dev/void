---
title: Build Log Delivery and Presentation
status: implemented
created: 2026-07-02
---

# Build log delivery and presentation

Container build logs have three consumers: the owner-facing
[`void build logs` command](../../../docs/en/reference/cli.md#build),
administrator views, and the completed `Void Build` GitHub check. They share
the BuildManager's retained SQLite log store. GitHub Actions builds instead
return their external run URL.

## Access and cursors

The project routes authenticate the user, establish project ownership, and
verify that the requested build belongs to that project before contacting its
Durable Object. Build summaries explicitly select public fields rather than
spreading database rows. Resolve the Durable Object class using the build's
persisted instance type.

Log rows have monotonically increasing sequence numbers. A caller resumes
after its last consumed sequence; the API also returns status, terminal state
and an optional external URL. The retained store is a bounded tail, not an
unlimited archive. CLI following must drain the final retained rows before
exiting on a terminal status.

## Producer-to-consumer delivery

The container agent exposes paged logs. BuildManager polls the existing
container port without auto-starting an exited container. Advance the producer
cursor only after durable SQLite ingestion; a following request carrying that
cursor acknowledges ingestion to the producer.

Keep one in-flight pull across scheduled polling, cancellation and final
draining. Network I/O releases Durable Object input gates, so separate entry
points can otherwise ingest the same page twice.

Natural exit keeps the producer available until acknowledged logs drain, with
an idle deadline that resets only on cursor progress and a non-resettable
absolute cap. Forced teardown revokes build authority, joins the current pull,
performs a fresh bounded drain, checks liveness, and signals the container.
Serialize this whole sequence so no late pull can appear after the terminal
marker.

Use both elapsed-time and input-work limits. Page count alone does not bound
latency, line count alone does not bound bytes, and a Worker clock does not
bound synchronous CPU work. Charge serialized payload size and fan-out work
before processing atomic rows. Keep producer and consumer byte budgets in the
same units.

## Rendering

Capture raw terminal output so terminal consumers retain its semantics.
Render HTML and Markdown from the visible terminal state using
`@xterm/headless`; a regex that strips ANSI sequences cannot model cursor
movement, erasure or overwritten progress frames.

Apply deterministic input and parameter-work bounds before terminal handlers.
Keep rendering state across related rows, and stop conservatively at a
truncated state-changing group instead of inventing a fresh terminal state.
Sanitize before selecting the visible tail so erased output does not consume
the display budget.

GitHub's output limit is measured in UTF-8 bytes. Enforce the limit on the
complete Markdown body, including fences and truncation markers. Choose a
fence longer than any backtick run in the log content.

## Verification boundaries

Exercise the real agent and BuildManager delivery protocol, not a copy of its
algorithm. Cover rapid failure before the first poll, concurrent cancellation,
partial drains, cursor acknowledgement, terminal markers, byte-heavy output,
and database writes that settle after their wait timed out. Construct every
piece of state a real peer would write before testing a concurrent handler.

Implementation and limits live in
[BuildManager](../../packages/api/src/build-manager.ts) and the
[container agent](../../packages/api/container/build-agent.mjs).
The original task checklist, copied source/tests and historical test counts are
retired.

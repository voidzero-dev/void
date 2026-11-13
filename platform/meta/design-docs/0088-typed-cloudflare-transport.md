---
title: Typed Cloudflare transport
status: implemented
created: 2026-10-02
---

# Typed Cloudflare transport

## Contract

App deployment and platform installation keep their existing orchestration.
Provider requests use the discriminated `CloudflareOperation` contract in
`@void/deploy-cloudflare`. Public targets are fields; secrets and Hyperdrive
connection strings use stdin or private temporary files. Results carry provider
data, codes, errors and process provenance. Diagnostics remain human text.

The private process entry accepts exactly one JSON request and returns one
validated envelope. Interactive login and tail retain terminal streaming.
Callers never construct historical Wrangler arguments or parse imitation output.
Pinned `cf` CLI presentation is decoded only at the actual provider boundary.
The old `cf-compat` entry and its argument/flag parser are deleted.

## Preserved behavior

Keep account and endpoint pinning, generated config and lock persistence,
pagination, ownership checks, absent-resource confirmation and fail-closed
malformed responses. Cancellation, process-group termination and lock quarantine
still dominate buffered provider results. Preserve uploader hashes and artifact
verification, active-secret lineage, cutover, trigger publication and rollback.
The matching platform payload stays bundled with `void`. Public CLI syntax,
authentication destinations and Workers Free defaults are unchanged.

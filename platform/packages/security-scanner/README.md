# @voidcloud/security-scanner

The scanner runner for security audits on deploy (design doc
[0095](../../meta/design-docs/0095-security-audits.md)). It runs inside the
scanner container, which has no internet. `vp pack` builds one Node file,
`dist/runner.mjs`, with no runtime dependencies.

## Contract with the controller

```
controller ──stdin tar──► node runner.mjs --stdin-tar [--root /scan]
                           │ unpack: task.json, input/**, memory/** (regular files only)
                           │ hunt session ─► ≤ 10 verify sessions (fresh each)
                           │   model calls: POST http://model.void.internal/v1/chat/completions
                           ▼
                          /scan/out/findings.json   then   /scan/out/status.json (renamed in whole)
```

- Start: a short argv, input on stdin. Exit 0 means `status.json` was written,
  whatever the scan status. SIGTERM ends the session (or the tar read) and writes `timed_out`.
- `task.json` (version 1): `scan_id`, `attempt`, `engine`
  (`void_loop` | `agent_sdk` | `codex_sdk`), `model`, `tier`
  (`source_diff` | `built_diff` | `full`), `changed_files` (relative to
  `/scan/input`), optional `limits.max_turns` (≤ 40) and `limits.max_verify`
  (≤ 10). Unknown fields are ignored.
- The tar may hold only `task.json`, `input/…` and `memory/…`. Symlinks, links,
  devices, `..`, absolute paths and duplicates refuse the whole input
  (`failed`, `error_class: input_invalid`).
- `findings.json`: `{schema_version: 1, run_status, findings, notes}`. Records
  follow `src/runner/report.ts`; `validate-findings.ts` checks them (≤ 5 MiB,
  ≤ 1,000 records, no unknown fields). The API repeats the check before ingest.
- `status.json`: `status` (`succeeded` | `incomplete` | `failed` | `refused` |
  `timed_out`), `reason`, `error_class`, `refusal_category`, per-session counts,
  model calls and tokens (a cross-check; the proxy meters spend).

## Model proxy stops

The proxy refuses a call with a non-2xx status and `x-void-scan-stop:` one of
`session_calls`, `scan_calls`, `tokens`, `budget`, `credits`. A bare 402 is
`credits`. Stops end the session as `incomplete` (or `failed (credits)`); any
other failure (another non-2xx status, a network error, an unreadable body) is
retried once, then `failed (infrastructure)`.

## Engines

`src/runner/engines/types.ts` is the engine interface. Engine B (`void-loop.ts`,
`@cf/*` models) ships now. Engines A (Claude Agent SDK) and C (Codex SDK) plug in
through `runScan({ engineFactory })` in their own images; their SDKs are not
workspace dependencies. `status.ts` already maps their signals.

## Tests

`vp test run platform/packages/security-scanner`. The fake model server in
`test/fake-model/server.ts` serves scripted chat-completions JSON and SSE.

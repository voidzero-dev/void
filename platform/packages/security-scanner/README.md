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

- Probe: `node runner.mjs --self-test` prints one JSON line (uid, model route
  answer, egress targets, credential-like env names) for probe checks 2 and 3.
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

`src/runner/engines/types.ts` is the engine interface; `run.ts` picks the engine from
`task.json`.

- Engine B (`void-loop.ts`, `@cf/*`): our own tool loop. It ships in the managed image.
- Engine A (`claude.ts`, `anthropic/*`): the Claude Agent SDK, three read tools, no shell.
- Engine C (`codex.ts`, `openai/*`): the Codex SDK with only the `void-scan` MCP server
  (`mcp/`, built to `dist/void-scan-mcp.mjs`). `image/codex-wrapper.sh` adds the lockdown flags.

The SDKs are not workspace dependencies. `image/Dockerfile.claude` and
`image/Dockerfile.codex` install exact pins (`image/*/package.json`, `package-lock.json`)
next to `runner.mjs` in `/opt/void-scanner`; `test/unit/image-pins.test.ts` keeps them in
step. Build the bundle first (`vp run --filter ./platform/packages/security-scanner build`),
then `docker build --platform linux/amd64 -f platform/packages/security-scanner/image/Dockerfile.<claude|codex> .`.
After a session that sent no report, engines A and C ask the model proxy why
(`GET /v1/void/last-failure`); `status.ts` maps the answer.

## Tests

`vp test run platform/packages/security-scanner`. The fake model server in
`test/fake-model/server.ts` serves scripted chat-completions JSON and SSE.

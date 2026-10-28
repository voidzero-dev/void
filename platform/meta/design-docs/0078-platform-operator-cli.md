---
title: Platform Operator CLI
status: implemented
created: 2026-09-15
---

# Platform operator CLI

The terminal and browser administrator interfaces share server operations.
Current commands and setup live in
[Platform Administration](../../../docs/en/guide/platform-administration.md) and
the [CLI reference](../../../docs/en/reference/cli.md#operator-commands).

## Authentication and origin

The JSON API at `/operator/v1` requires a dedicated bearer token with
audience `operator`. An active administrator explicitly exchanges a full API
session for a short-lived operator session. Every request checks expiry,
revocation, current role and suspension state.

Operator credentials use separate origin-scoped keychain entries;
`VOID_OPERATOR_TOKEN` supplies headless credentials. Browser cookies and
project deployment tokens cannot authenticate this API. Command destination
selection uses explicit connection options or the active connection, never
repository metadata that could redirect administrator credentials.

## Mutation contract

Reads use GET. Mutations use bounded JSON POST bodies and accept
`dryRun: true` for a concrete preview without writes. CLI mutation commands
preview the selected origin and affected objects before confirmation;
`--plan` exits after preview and `--yes` supports an explicit scripted apply.
Noninteractive invocations without either option fail before mutation.

Both interfaces record audit intent and outcome. Do not retry uncertain
mutations automatically. Report partial outcomes and retain the information
needed for recovery. Structured output goes to stdout; diagnostics go to stderr.

## Last-administrator protection

Deletion, demotion and suspension must preserve at least one active
administrator. The same guard applies to browser operations, operator routes
and low-level helpers; this design adds no recovery or promotion bypass.

A PostgreSQL transaction serializes user writes, verifies another
administrator's access, and revokes the target's access before external
cleanup. That revocation survives cleanup failure. Automatic quota changes
cannot overwrite a manual suspension. Preview checks the guard without
revoking access.

Regression coverage includes concurrent removals, browser/CLI parity,
credential-audience and origin separation, failed cleanup, audit failure,
quota ordering and previews without writes. The historical task checklist,
review transcript and fixed test counts are retired.

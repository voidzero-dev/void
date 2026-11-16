---
title: Actionable project permission errors
status: implemented
created: 2026-09-23
---

# Actionable project permission errors

Project roles are enforced by the API, but several rejected CLI operations show
raw `403 {"error":"forbidden"}` output. Users need the attempted action, the
required access, and a useful next step. Deployment and invitation responses
already provide some guidance; the remaining paths should meet the same standard.

## Contract

- Preserve HTTP statuses and existing machine-readable `error` values. Add a
  separate `message` field to project access denials and expected team errors.
- Derive required access from the checked capability. Do not infer the caller's
  actual role or disclose project/member details in a denied response.
- Cover initial checks and repeated checks under transaction locks. Credential
  scope, inactive builds, suspension, owner-only operations and invitation
  conflicts require different recovery instructions.
- Have CLI and dashboard presentation prefer meaningful messages, with safe
  fallbacks for older APIs. Preserve structured error properties for callers and
  specialized invitation/account guidance. Do not print JSON or HTML as ordinary
  permission-error copy.

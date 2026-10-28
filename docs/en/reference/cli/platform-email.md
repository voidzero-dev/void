---
outline: deep
---

# Platform Email {#operator-email}

Use your administrator session for these commands. See [Platform Management](./platform.md#operator-commands) for platform selection, previews, and confirmation.

Decide who mail from the shared sender may reach, who registers email domains, and a project's outbound caps:

```sh
void platform email policy
void platform email policy-set <verified|domains|any> [--domains <domain[,domain...]>]
void platform email settings
void platform email settings-set --domains <self-serve|admin>
void platform email limit <project-id|slug> [--monthly <n>] [--burst <n>]
void platform email logs <project-id|slug> [--page <n>] [--limit <n>] [--json]
void platform email attempts [--project <id|slug>] [--page <n>] [--limit <n>]
void platform email attempt-resolve <attempt-id> --ended --reason <text>
void platform email operation-resolve <operation-id> --ended --outcome <applied|not-applied> --reason <text>
void platform email shared-recipients [--project <id|slug>] [--page <n>] [--limit <n>]
void platform email shared-recipient-resolve <recipient-id> --ended --outcome <applied|not-applied> --reason <text>
```

`policy` decides which recipients a project's `<slug>+tag@<mail domain>` sender reaches: `verified` (the default) means only that project's verified destinations; `domains` adds every address on the listed domains; `any` lifts the check. Neither widens delivery to addresses on the platform's own mail domain: those stay verified-destination-only, so no project reaches another project's inbox without its consent. Cloudflare still refuses a destination it has not verified until the platform mail domain is onboarded for Email Sending, so under `domains` or `any` such refusals arrive as per-recipient `UNVERIFIED_DESTINATION` results. Custom-domain sends are not affected.

`settings-set --domains admin` tells `void email domain add` to print the administrator's command instead of starting token setup. `limit` overrides the project's monthly and rolling 60-second caps (defaults 200 and 10); a project page in the admin UI shows and clears them.

`logs` inspects retained receipt and recipient outcomes, including operation IDs, provider references, error codes, and policy versions. Pages contain at most 100 records, newest first; use `--json` for all fields. After project deletion, use its project ID to inspect metadata until the 30-day retention period expires. Message content and credentials are never included.

`attempts` lists interrupted provider calls and their earliest resolution time. Once
the original Worker execution has ended and the attempt is at least 24 hours old,
`attempt-resolve` records `outcome_unknown`, retains its quota charge, and releases
the project/domain cleanup fence. `--ended` is your attestation that the call is no
longer active; `--reason` is stored in the operator audit log. Keep recipient
addresses and message content out of the reason. The send is never retried. Use
`--plan` to preview and `--yes` to apply without a prompt.

`operation-resolve` recovers a Cloudflare routing, Worker, secret, catch-all, or
Sending mutation whose outcome remains unknown. After the original execution
has ended and the operation is at least 24 hours old, inspect the exact resource
named by the preview and attest whether its write was `applied` or `not-applied`.
Applied writes continue at the next step; not-applied writes retry the same
persisted intent. The running platform version must match that intent, so restore
the matching version before recovering an operation created by older code. Time
alone never retries a write.

`shared-recipients` discovers shared inbound addresses, provider rule names and
IDs, and interrupted creation intents, including projects awaiting deletion.
If creation has an unknown outcome, use `shared-recipient-resolve` after the
original execution has ended and its creation intent is at least 24 hours old.
Inspect the exact account, zone, recipient and rule named by `--plan`, and use
Cloudflare's provider audit to establish whether creation was `applied` or
`not-applied`. A missing rule alone is insufficient evidence for `not-applied`.
Supply that finding in `--reason`; it is recorded in platform events.

Applied recovery requires the exact owned rule to be present and records its
ID. Not-applied recovery releases the creation intent only after repeated
provider inspection and your attestation. Both outcomes leave delivery unready
until normal reconciliation verifies it. Recovery itself creates or deletes no
provider rule and never reopens a deleting project; retry deletion afterward
when recovering cleanup. Use `--yes` to apply the preview without a prompt.
If the intent or provider ownership changes, inspect a new plan.

Register and maintain email domains for projects whose owners hold no Cloudflare credential:

```sh
void platform email domains [--project <id|slug>]
void platform email domain-add <domain> --project <id|slug> [--token-stdin] [--outbound-only]
void platform email domain-status <domain>
void platform email domain-sync <domain>
void platform email domain-rotate-secret <domain>
void platform email domain-remove <domain> [--token-stdin]
```

`domain-add` uses the platform's Cloudflare credential for zones in its account. For another account, pipe a scoped Cloudflare API token on standard input with `--token-stdin --yes`. Managed custom inbound email requires the Cloudflare zone apex (`example.com`). If its MX records already belong to another mail provider, such as Microsoft 365 or Google Workspace, add `--outbound-only` to send from the apex while that provider keeps receiving its mail; see [Sending from a domain that already receives mail](../../guide/platform/administration/email.md#sending-from-a-domain-that-already-receives-mail). Otherwise use the project's shared email address or choose another unused zone. Native Cloudflare deployments also support literal recipient addresses on subdomains; see [Your own Cloudflare account](../../guide/email/domains.md#your-own-cloudflare-account).

`domain-status` shows inbound, outbound, and credential-management readiness with the latest operation. A blocked operation resumes through `domain-sync`; a blocked rotation resumes through `domain-rotate-secret`, preserving already confirmed steps and its staged credential. An uncertain operation remains stopped until read-back proves the result or an administrator uses `operation-resolve`. Domains an administrator adds show `managed_by: admin`; their owners can list and inspect them but use these commands for `sync`, `domain-rotate-secret`, and `remove`.

If project deletion leaves cleanup blocked by an expired or revoked Cloudflare token, use `domain-remove <domain> --token-stdin --yes` with a replacement scoped to the same account and zone. This resumes the retained cleanup only when no other project uses the connection. For a live project, renew its token through `domain-add` instead.

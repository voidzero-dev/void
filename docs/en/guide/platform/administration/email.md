---
outline: deep
---

# Email

## Managing Email

These commands apply to a platform that enables email. Every project can send from `<slug>+tag@<mail domain>` on the platform’s shared mail domain. Deploying an app with `email/` handlers sets up receiving at that address once its recipient rule is ready; the [email guide](/guide/email) describes what applications do with that.

Shared inbound mail uses one exact routing rule per receiving project and enables Cloudflare’s per-zone plus addressing. Creating a project or deploying an app that only sends mail consumes no inbound rule. Existing rules and the apex catch-all remain in place. Cloudflare normally allows [200 routing rules per domain](https://developers.cloudflare.com/email-service/platform/limits/); remove unused rules or request a higher limit if the shared domain reaches capacity. An unrelated rule for a project’s base address or a plus address blocks its setup until that conflict is removed.

A project owner can give the shared address one permanent, shorter name with `void email alias <name>`. A receiving project with an alias uses two rules, one for the slug and one for the alias, because the slug address keeps working. Setting an alias is refused while a conflicting rule exists or the domain is at its rule limit, and the alias is released only when the project is deleted.

If recipient creation is interrupted, inspect its retained intent:

```sh
void platform email shared-recipients --project my-app
void platform email shared-recipient-resolve <recipient-id> --ended --outcome not-applied --reason "Provider audit confirms the request did not create a rule" --plan
```

Wait until the reported recovery time, confirm the original execution ended,
and inspect the exact provider resource shown in the plan. Use `applied` when
the exact owned rule exists, or `not-applied` only when the provider audit
establishes that creation did not occur. Absence alone does not establish the
outcome. Run the same command with `--yes` after inspection. Recovery records
the decision in platform events without creating or deleting rules. Normal
reconciliation verifies delivery afterward; a deleting project stays closed
and its deletion can be retried. See [operator email commands](../../../reference/cli/platform-email.md#operator-email)
for the recovery requirements.

### Mail that the platform sends {#platform-sender}

The platform sends its own mail, for example invitations, welcome mail, failed-deploy notices, and error alerts. This mail comes from `noreply@<mail domain>`, and the sender name is the platform's display name. Void sets this sender, so you do not need to configure one. Do not set a different sender on the platform Workers in the Cloudflare dashboard. That change stops the next `upgrade`, `repair`, `enable`, or `rollback` until you let Void replace it. See [Platform Workers changed outside Void](/guide/platform/installation/maintenance#workers-changed-outside-void).

Mail to an address that is not verified needs Cloudflare Email Sending onboarding and [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans).

### Deciding who mail may reach

By default, mail from the shared sender reaches only the recipients each project has verified. For a team whose applications mainly mail colleagues, widen that once for the whole installation:

```sh
void platform email policy
void platform email policy-set domains --domains example.com,corp.example.net
void platform email policy-set any
void platform email policy-set verified
```

Choose a policy in the admin UI's **Email** page or with the commands above:

- `verified`: only each project's verified recipients.
- `domains`: verified recipients plus any address on the listed domains.
- `any`: any recipient.

Unverified recipients still require Cloudflare Email Sending onboarding and [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans). Otherwise those sends return `UNVERIFIED_DESTINATION`. Mail from a project's custom domain, and mail to the platform's own mail domain, always requires recipient verification.

Policy changes apply to new sends; admitted attempts may finish.

### Project caps

Each project has 200 recipient submissions per UTC calendar month and 10 in a rolling 60-second window by default. An attempt stays charged once it starts, including a failed or uncertain outcome. Raise or lower a project's caps by id or slug:

```sh
void platform email limit hr-portal --monthly 2000 --burst 30
```

The project's page in the admin UI shows the current values and clears an override.

### Recovering an interrupted send

If a sender stops after beginning a provider call, its unresolved attempt blocks
removal of the project or sender domain. Inspect the attempt ID and start time:

```sh
void platform email attempts --project hr-portal
```

First confirm that the original execution has ended through your Worker logs or
incident records. Once the attempt is at least 24 hours old, resolve it with an
audit reason that contains no recipient address or message content:

```sh
void platform email attempt-resolve <attempt-id> --ended --reason "Original Worker execution ended; provider outcome could not be verified" --plan
void platform email attempt-resolve <attempt-id> --ended --reason "Original Worker execution ended; provider outcome could not be verified"
```

This records the send as `outcome_unknown` and releases its cleanup fence. The
attempt remains charged and is never retried. If its 30-day delivery record has
expired, only its recipient-free fence is removed. Do not resolve an attempt
while its original execution may still be active.

Inspect a project's retained receipt and recipient outcomes with:

```sh
void platform email logs hr-portal --page 1 --limit 50 --json
```

Logs include operation IDs, recorded outcomes, provider references, and error codes.
After project deletion, use its project ID until the 30-day metadata retention
period expires. Message bodies, subjects, attachments, and credentials are not logged.

### Registering email domains for projects

Your users may hold no Cloudflare account. Tell the platform that administrators register email domains, so `void email domain add` prints the command to ask you for instead of opening a token-creation page:

```sh
void platform email settings-set --domains admin
```

Then register a domain for a project. The zone must be in the platform's Cloudflare account; the platform's own credential does the setup, and no Cloudflare credential is stored per domain:

```sh
void platform email domain-add example.com --project hr-portal
void platform email domain-status example.com
void platform email domain-rotate-secret example.com
void platform email domains
```

Use the apex of the selected Cloudflare zone. Platform-managed custom inbound email uses its catch-all, which does not cover subdomains; choose an apex without another mail provider or use the platform’s shared mail address. `domain-status` reports inbound, outbound, and management readiness separately. Follow any required DNS or Cloudflare dashboard step, then use `domain-sync` to reconcile. Use `domain-rotate-secret` when you need to replace the zone ingress credential explicitly. Email Sending onboarding needs Workers Paid; after upgrading, `domain-sync` re-attempts it. For a zone in another Cloudflare account, pipe an API token for that account on standard input:

```sh
void platform email domain-add other.example --project hr-portal --token-stdin --yes < token.txt
```

Project owners see administrator-registered domains in `void email domain list` and `status`; `status` names the `void platform email` command for any step they cannot take themselves, and `sync` and `remove` point them at `domain-sync` and `domain-remove`. A domain an owner registered before you switched to `admin` stays theirs to renew, sync and remove. The runtime token needs the [email permissions](/guide/platform/installation/credentials#enable-email) for this to work.

A permission refusal leaves setup blocked. After correcting it, run `domain-sync`
to resume that same setup operation; repeat `domain-rotate-secret` to resume a
blocked rotation without replacing its staged secret. If project deletion leaves
a blocked domain cleanup, correct the permission and run `domain-remove <domain>`
to finish the retained cleanup. If its token has expired or been revoked, provide
a replacement scoped to the same account and zone:

```sh
void platform email domain-remove other.example --token-stdin --yes < token.txt
```

This recovery is available only after project deletion has begun and no other
project uses the connection. For a live project, renew its token through
`domain-add`. A timed-out Cloudflare
mutation stays stopped because replay may duplicate a provider write. After
confirming the original execution ended, wait 24 hours, inspect the exact
routing, Worker, secret, catch-all, or Sending resource named by the preview,
and use its recovery fence:

```sh
void platform email operation-resolve <operation-id> --ended --outcome <applied|not-applied> --reason "Provider state verified" --plan
void platform email operation-resolve <operation-id> --ended --outcome <applied|not-applied> --reason "Provider state verified"
```

Run recovery with the same platform version that created the persisted intent.
`applied` continues without replaying the write; `not-applied` permits that exact
step to retry. Secret rotation keeps its staged generation, and removal resumes
from the unresolved cleanup step. Age alone never authorizes a retry.

### Sending from a domain that already receives mail

If an apex already receives mail with another provider, such as Microsoft 365 or Google Workspace, register it for sending only:

```sh
void platform email domain-add brand.example --project hr-portal --outbound-only
```

The project can then send from any address on the apex, such as `support@brand.example`. It cannot receive mail there: the MX records, the apex SPF record, and incoming mail stay with the current provider.

- Cloudflare Email Sending must be available, which needs Workers Paid. Without it, setup is blocked instead of falling back to verified destinations only. Upgrade, then run `domain-sync`.
- Email Sending adds its own records on `cf-bounce.<domain>` and `_dmarc.<domain>`. If Cloudflare reports that existing records conflict with them, for example several DMARC records, setup is blocked and the error lists each record. Fix them, then run `domain-sync`.
- Only administrators can register an outbound-only domain, and it must be a zone apex. The platform's shared mail zone cannot be outbound-only.
- `domain-rotate-secret` does not apply. `domain-remove` stops sending through the platform and leaves the MX records alone.
- To switch an outbound-only domain to platform-managed inbound mail, or back, remove it first and add it again.

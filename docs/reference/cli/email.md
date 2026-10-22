---
outline: deep
---

# Email {#email}

Inspect email usage and manage the recipients a project is allowed to send to. See [Email](../../guide/email.md) for the runtime API.

Project resolution for email commands follows the same order as deploy (`--project`, `VOID_PROJECT`, linked project). `void email setup` and `void email status --platform cloudflare` are the exception: they act on your own Cloudflare account through your Cloudflare sign-in (`void cloudflare login`) and need no Void project.

## `void email usage` {#void-email-usage}

```
void email usage [--project <name>]
```

Show the current month's recipient attempts and inbound receipts, the monthly attempt limit, and how much of it is left. Reserved submissions count toward the limit; started attempts remain charged even if delivery fails or its outcome is unknown. A suspended project is flagged in the output.

## `void email logs` {#void-email-logs}

```
void email logs [--limit <n>] [--project <name>]
```

Show recent email operation metadata retained for 30 days: timestamp, direction, operation ID, recipient, and state. `--limit` accepts 1–100. Subjects, bodies, and attachments are not stored. Provider acceptance does not confirm mailbox delivery; inspect unknown outcomes before retrying.

## `void email destinations` {#void-email-destinations}

```
void email destinations [--project <name>]
```

List the project's recipient addresses and their state (`verified`, `pending`, or `failed`). Outbound mail is only delivered to verified addresses.

## `void email allow` {#void-email-allow}

```
void email allow <address> [--project <name>]
```

Add one recipient to the project's destination list. Cloudflare emails that address a verification link — the recipient clicks it, with no Void or Cloudflare account required. Then run `void email destinations`: the listing is what records the click, and until it has, a send to that address returns `UNVERIFIED_DESTINATION` for that recipient. If the link did not arrive or has expired, run `void email allow <address>` again while the address is still pending — the CLI re-sends the link, or tells you how to get a fresh one.

The project owner's email is added automatically when the project is created, so it skips this step but not the verification: unless Cloudflare already had it verified for an earlier project of yours, click the link it mailed and run `void email destinations`; until then a send to yourself returns `UNVERIFIED_DESTINATION` for that recipient.

## `void email disallow` {#void-email-disallow}

```
void email disallow <address> [--project <name>]
```

Remove one recipient from the project's destination list. New sends to that address are refused immediately; previously admitted attempts may finish. No deploy is involved.

## `void email alias` {#void-email-alias}

```
void email alias [--project <name>]
void email alias <name> [--yes] [--project <name>]
```

With no name, show the project's address on the platform's shared mail domain and whether inbound mail reaches it.

With a name, give that address a shorter name: `void email alias acme` makes `acme@<mail domain>` and `acme+<tag>@<mail domain>` reach the project and lets it send from them. Only the project owner can set it. The name follows the same rules as a project slug, must not be used by any other project's slug or alias, and names of five characters or fewer need a plan that allows short names.

The alias is permanent: it cannot be changed or removed, and it is freed only when the project is deleted. The slug address keeps working for sending and receiving, so nothing that already uses it breaks. The CLI asks for confirmation; pass `--yes` to skip the prompt, which is required outside an interactive terminal. Inbound mail at the alias starts once the project has `email/` handlers deployed and its recipient rule is ready; run `void email alias` to check. Redeploy with the current `void` before you share the alias: an app built with an older version sees `message.to` with the alias still in front (`acme+support@…` instead of `support@…`).

## `void email domain` {#void-email-domain}

```
void email domain <add|status|list|sync|rotate-secret|remove> [<domain>] [--project <name>]
```

Send and receive at your own domain on a Cloudflare zone you own, registered to the project. Void platform only — on your own Cloudflare account the mail domain comes from `email.from` instead (see `void email setup`). The walkthrough is [Your own domain on the platform](../../guide/email/domains.md#your-own-domain-on-the-platform).

### `void email domain add` {#void-email-domain-add}

```
void email domain add <domain> [--project <name>]
```

Register an exact domain with the project using a scoped Cloudflare API token. The CLI opens a token template, accepts a masked paste or newly copied token, and asks you to confirm account and zone restrictions. Credentials are encrypted for the zone connection. Custom inbound email requires a Cloudflare zone apex because its catch-all does not cover subdomains. Foreign MX records and catch-alls are preserved; use another zone apex or the platform shared mail address when the apex already receives mail. Each custom apex belongs to one project. Setup returns an operation ID so an interrupted request can be checked without restarting the operation.

### `void email domain status` {#void-email-domain-status}

```
void email domain status <domain> [--project <name>]
```

Show the recorded inbound, outbound, and management readiness, observation times, and latest operation. Use `sync` to reconcile setup and refresh readiness.

### `void email domain list` {#void-email-domain-list}

```
void email domain list [--project <name>]
```

List the project's registered email domains and readiness.

### `void email domain sync` {#void-email-domain-sync}

```
void email domain sync <domain> [--project <name>]
```

Reconcile the domain connection and refresh readiness. Sync does not rotate its secret. A blocked or uncertain operation exits unsuccessfully and names the operation to inspect.

### `void email domain rotate-secret` {#void-email-domain-rotate-secret}

```sh
void email domain rotate-secret <domain> [--project <name>]
```

Rotate the connection secret shared by this domain and other domains on the same zone. Inbound delivery must be ready; run `void email domain sync <domain>` first if setup is incomplete. Inspect an uncertain result before retrying.

### `void email domain remove` {#void-email-domain-remove}

```
void email domain remove <domain> [--project <name>]
```

Disable the domain assignment and record cleanup. Zone resources used by another domain remain available. Unfinished or uncertain cleanup remains recorded until it can be reconciled safely.

## `void email status` {#void-email-status}

```
void email status --platform cloudflare
```

Check the domain configured in `email.from`: permissions, DNS, routing, sending, handler addresses, and the email binding. Exits unsuccessfully when setup is incomplete. Workers Free setup can be ready with sending limited to verified destinations; run `void email setup --platform cloudflare` after upgrading to Workers Paid.

`void email status` reads only your own Cloudflare account, so `--platform cloudflare` is required. On the Void platform, use `void email usage` and `void email destinations`.

## `void email setup` {#void-email-setup}

```
void email setup --platform cloudflare
```

Set up email before deploying from CI. Requires `email.from` in `void.config.ts`, an interactive terminal, and Cloudflare email permissions.

Void shows the planned DNS, routing, plus-addressing, and sending changes and asks before applying them. Commit `void.lock.json`, then run `void deploy --platform cloudflare --require-email` in CI.

On Workers Free, inbound mail and sends to verified recipients remain available. Run this command again after upgrading to Workers Paid to enable arbitrary recipients. See [Email setup](../../guide/email/domains.md#your-own-cloudflare-account).

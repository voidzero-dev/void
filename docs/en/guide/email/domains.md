---
outline: deep
---

# Email Domains and Setup

Choose the setup for your deployment: register a domain on a Void platform, or configure email in your own Cloudflare account. For the platform’s shared sender, follow [Sending Email](./sending.md#setup).

## Your own domain on the platform {#your-own-domain-on-the-platform}

The shared sender uses the platform's configured mail domain. To send — and receive — at a domain you own, register its Cloudflare zone with the project:

```sh
void email domain add acme.com
```

`add` opens a Cloudflare API-token template. Restrict the token to the selected account and mail zone before creating it; Workers Scripts permission applies across that account. The CLI accepts a masked paste or a newly copied token and asks you to confirm those restrictions. The platform encrypts the credential for the zone connection, so projects sharing that zone do not need separate ingress Workers.

Platform-managed custom inbound email requires the apex of a Cloudflare zone. Cloudflare’s catch-all only covers that apex, so a subdomain of the selected zone cannot receive arbitrary addresses. `add` refuses to register a new apex that already has MX records, or whose catch-all already routes elsewhere, so it never takes over mail hosted with another provider such as Microsoft 365 or Google Workspace. Use an apex that has no mail yet, or the platform’s shared mail address. To only send from an apex that keeps its current mail provider, ask your platform administrator to register it as [outbound-only](../platform/administration/email.md#sending-from-a-domain-that-already-receives-mail). Running `add` again for a registered apex, for example to renew its token, keeps working. Each custom apex belongs to one project; a project can register more than one apex.

If setup is interrupted, use `void email domain status <domain>` to inspect the saved operation before retrying.

`void email domain status <domain>` reports three independent results:

- **Inbound**: whether mail can reach the project's handlers.
- **Outbound**: whether sending is ready, restricted to verified destinations, pending, or blocked.
- **Management**: whether the stored Cloudflare credential can manage the connection.

Use `void email domain sync <domain>` to finish setup and refresh readiness. The status lists any dashboard or credential steps still needed. Use `rotate-secret` to rotate the connection secret after inbound is ready, or `remove` to detach the domain. Revoke unused API tokens in Cloudflare. See [Email domain commands](../../reference/cli/email.md#void-email-domain).

Once inbound is ready, mail to any address on that domain reaches your `email/` handlers. Sending to arbitrary recipients also needs outbound readiness; a domain limited to verified destinations still requires recipient verification. Platform quotas and suspension apply to both shared and custom senders.

On an administrator-managed platform, `add` prints the administrator command for new domains. Existing owner-managed connections remain available to their owner. Your administrator may permit shared-sender mail to specific recipient domains or any recipient; destinations on the platform's shared mail domain still require explicit verification.

## Your own Cloudflare account {#your-own-cloudflare-account}

Set a sender on a Cloudflare zone you own:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  email: { from: 'Acme <support@mail.acme.com>' },
});
```

Use a mail subdomain to keep existing mail on `acme.com` with its current provider. Void refuses to replace another provider's MX records.

### Setup {#setup-1}

Sign in with `void cloudflare login`, or use a `CLOUDFLARE_API_TOKEN` with **Email Routing Edit** and **Email Sending Edit** in addition to deploy permissions. If your browser session lacks email permissions, log out and sign in again. Global API Keys aren't supported.

Run `void deploy --platform cloudflare`. Void shows the domain, routing, sending, DNS, and handler addresses it would configure. Accept to set up email and deploy. Later deploys reuse the setup. If you decline the initial setup, the app deploys without email.

Without `email.from`, Void skips automatic setup and preserves authored `cloudflare.send_email` bindings and `cloudflare.addresses`; check their readiness yourself. `--require-email` still refuses deployment when automatic setup cannot be verified.

If subdomain setup needs a dashboard step, follow the checklist under **Email → Settings → Subdomains**, then retry. After DNS changes, check readiness with:

```sh
void email status --platform cloudflare
```

### Inbound addresses {#inbound-addresses}

With `email.from` on `mail.acme.com`, handlers receive:

| Handler                             | Subdomain address       | Zone apex address  |
| ----------------------------------- | ----------------------- | ------------------ |
| `support.ts`, `support+[ticket].ts` | `support@mail.acme.com` | `support@acme.com` |
| `_default.ts`                       | No catch-all rule       | `*@acme.com`       |
| `[user].ts`, `[user]+[tag].ts`      | Not supported           | `*@acme.com`       |

Cloudflare catch-alls cover only a zone apex. On a subdomain, `_default.ts` can handle mail admitted by an explicit rule, but cannot receive arbitrary addresses.

Setup enables the zone's plus addressing so `support+T-42@mail.acme.com` reaches `support+[ticket].ts`. This setting also applies to the apex and other subdomains.

`replyEmail()` defaults its sender to the address that received the message. Forwarding requires a verified Cloudflare destination.

### Sending {#sending}

On Workers Free, `sendEmail()` can send to verified destinations listed under **Email Routing → Destination addresses** in Cloudflare.

Configure your sender domain's SPF, DKIM, and DMARC records using [Cloudflare's email authentication guidance](https://developers.cloudflare.com/email-service/concepts/email-authentication/), then check the authentication results in a received message's original headers. A successful `sendEmail()` result confirms provider acceptance; it does not confirm delivery or authentication readiness.

Sending to arbitrary recipients requires [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans) and Email Sending onboarding. After upgrading, run `void email setup --platform cloudflare`. Void doesn't retry onboarding during ordinary deploys.

Existing DMARC or bounce-domain records can block onboarding; the checklist identifies conflicts to resolve. Inbound mail remains available.

The `void email usage`, `logs`, `destinations`, `allow`, and `disallow` commands apply to Void platforms.

### Configuration changes {#configuration-changes}

Commit `void.lock.json` after setup. Void derives routing addresses from your handlers and creates their rules during deployment.

Existing rules owned by another Worker or forwarding service are left in place. If you manage `cloudflare.addresses` yourself, follow the checklist rather than combining it with automatic email setup.

After deleting a handler, review the reported stale address and set the desired `cloudflare.addresses`. Deleting a routing rule requires confirmation in an interactive terminal.

To remove all email setup, remove `addresses`, `send_email`, and `vars.__VOID_EMAIL_FROM` from `resolved` in `void.lock.json`, remove corresponding overrides in `void.config.ts`, and delete the routing rules in Cloudflare.

### CI {#ci}

Set up email locally first:

```sh
void email setup --platform cloudflare
void email status --platform cloudflare
```

Commit `void.lock.json`, then deploy in CI with:

```sh
void deploy --platform cloudflare --require-email
```

CI cannot answer setup prompts. Without `--require-email`, an unconfigured app can deploy without email. If setup is saved but DNS hasn't propagated, deployment waits for a later retry. Workers Free setup for verified recipients satisfies `--require-email`.

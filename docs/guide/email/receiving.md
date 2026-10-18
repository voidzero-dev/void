---
outline: deep
---

# Receiving Email {#inbound}

Receive mail with handlers in the top-level `email/` directory. Inbound handlers require a native Void app; framework and Node.js, Bun, or Deno builds do not support them.

```ts
// email/_default.ts — fallback for any unmatched recipient
import { defineEmail, parseEmail } from 'void/email';

export default defineEmail(async (message, env, ctx) => {
  const parsed = await parseEmail(message);

  if (parsed.subject?.startsWith('STOP')) {
    message.setReject('Use the unsubscribe link.');
    return;
  }

  await message.forward('archive@example.com');
});
```

The handler receives Cloudflare's native `ForwardableEmailMessage` plus an optional fourth `info` arg with `params` populated for dynamic / tagged route segments:

| Method                             | Purpose                                    |
| ---------------------------------- | ------------------------------------------ |
| `message.setReject(reason)`        | Reject the message with an SMTP error.     |
| `message.forward(to, headers?)`    | Forward to a verified destination.         |
| `replyEmail(message, options)`     | Send a threaded reply.                     |
| `message.reply({ from, to, raw })` | Reply using your own MIME bytes or stream. |

Returning without an action accepts the message. Use bare email addresses for `forward` and `message.reply`.

`parseEmail(message)` returns `from`, `to`, `subject`, `text`, `html`, `attachments`, and `headers`. Call it at most once per message — the underlying stream can only be read once.

## Per-recipient routing {#per-recipient-routing}

```
email/
  support.ts                — handles support@<your-domain>
  billing.ts                — handles billing@<your-domain>
  support+[ticket].ts       — handles support+ticket-123@... → info.params.ticket = "ticket-123"
  support+vip.ts            — handles exactly support+vip@..., ahead of support+[ticket].ts
  [user].ts                 — dynamic local-part   → info.params.user
  [user]+[tag].ts           — dynamic + subaddress → info.params.user, info.params.tag
  _default.ts               — fallback when no per-address pattern matches
```

Files are matched against the local-part of the `To` address (the portion before `@`), case-insensitive. **Match precedence (most specific wins):**

1. `support+vip.ts` (static + literal tag)
2. `support+[ticket].ts` (static + captured tag)
3. `support.ts` (static)
4. `[user]+vip.ts` (dynamic + literal tag)
5. `[user]+[tag].ts` (dynamic + captured tag)
6. `[user].ts` (dynamic)
7. `_default.ts` (fallback)

The first pattern that matches wins. Within a shape, a literal tag beats a captured tag — `support+vip@` reaches `support+vip.ts`, and every other `support+…@` reaches `support+[ticket].ts`. Handlers of the same shape are tried alphabetically.

If nothing matches and there's no `_default.ts`, control returns to Cloudflare and the sender receives a non-delivery report. Nested folders under `email/` are ignored — the recipient is a flat string, not a path.

## Threaded replies {#threaded-replies}

```ts
// email/support+[ticket].ts
import { defineEmail, parseEmail, replyEmail } from 'void/email';

export default defineEmail(async (message, env, ctx, info) => {
  const parsed = await parseEmail(message);
  await ticketStore.append(info!.params.ticket, parsed.text ?? '');

  await replyEmail(message, {
    text: `Got your message on ticket ${info!.params.ticket}.`,
  });
});
```

`replyEmail()` replies to the original sender with a threaded subject. You can override `subject`.

On a Void platform, the default sender is your project's shared address, or the address that received mail on your registered domain. Use that default for shared mail; `message.to` has the project prefix removed. Sender overrides must belong to your project.

Replies follow your project's recipient policy. Verify shared-sender recipients with `void email allow <address>`. Check `void email logs` for the provider outcome after the handler finishes.

Forwarding requires a native Cloudflare email event. For custom domains relayed through the platform, use replies instead.

## Configuring inbound delivery {#configuring-inbound-delivery}

On an email-enabled platform, `<slug>+anything@<mail domain>` reaches your
deployed `email/` handlers without per-project DNS setup once the platform has verified your recipient rule and enabled plus addressing. Void sets up that rule when you deploy handlers; creating a project or only sending mail requires no inbound rule. Deployment reports a routing conflict or capacity limit if setup cannot complete. A
[registered custom domain](./domains.md#your-own-domain-on-the-platform) reaches those
handlers once its inbound readiness is `ready`. Use `void email domain status`
to check current provider routing and any remaining setup steps.

For direct deployments, follow [Your own Cloudflare account](./domains.md#your-own-cloudflare-account) to configure inbound addresses.

The local dev server provides the outbound email inbox but has no inbound email trigger. Test inbound handlers with `createInboundTestHarness` below.

## Testing inbound handlers {#testing-inbound-handlers}

Use `createInboundTestHarness` to capture replies, forwards, and rejections. For shared platform mail, pass the full address including the project prefix, such as [`acme+support+abc-123@acme.dev`](mailto:acme+support+abc-123@acme.dev). For direct Cloudflare mail, set `slug: null` and use [`support+abc-123@mail.acme.com`](mailto:support+abc-123@mail.acme.com).

```ts
import { describe, it, expect } from 'vitest';
import { createInboundTestHarness } from 'void/email/testing';
import defaultHandler from './email/_default';
import support from './email/support+[ticket]';

describe('email handlers', () => {
  it('routes to support+[ticket] and extracts the tag', async () => {
    const harness = createInboundTestHarness({
      routes: { 'support+[ticket]': support, _default: defaultHandler },
    });
    const result = await harness.deliver({
      from: 'user@example.com',
      to: 'acme+support+abc-123@acme.dev',
      subject: 'Help',
      text: 'I have a problem',
    });
    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'abc-123' });
  });

  it('rejects STOP messages via _default', async () => {
    const harness = createInboundTestHarness({ routes: { _default: defaultHandler } });
    await harness.deliver({
      from: 'user@example.com',
      to: 'acme+unknown@acme.dev',
      subject: 'STOP',
      text: 'bye',
    });
    expect(harness.rejects).toEqual(['Use the unsubscribe link.']);
  });
});
```

The harness matches handlers in the same order as deployed email routes.

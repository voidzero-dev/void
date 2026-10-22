---
outline: deep
---

# Sending Email

Use `sendEmail` to send transactional email. During development, Void captures messages in a local inbox.

```ts
import { sendEmail } from 'void/email';

const result = await sendEmail({
  from: 'Acme <acme+noreply@mail.example.com>', // use your project's sender address
  to: 'user@example.com',
  subject: 'Welcome',
  text: 'Thanks for signing up!',
  // html: '<p>Thanks for signing up!</p>', // optional — sent as multipart/alternative when paired with text
});

if (!result.ok) {
  if ('error' in result) {
    // A request-level failure; OUTCOME_UNKNOWN may already have been submitted.
    console.error(result.error.code, result.error.message);
  } else {
    // Some recipients failed. `deliveries` says which.
    for (const d of result.deliveries.filter((d) => !d.ok)) {
      console.error(d.recipient, d.error.code, d.error.message);
    }
  }
}
```

Check both failure shapes: `result.error` reports a request failure, while `result.deliveries` reports failures for individual recipients. An unverified recipient fails in `deliveries`.

## Setup {#setup}

On a platform with email enabled, deploy without additional email configuration. Ask your administrator for its shared mail domain. Administrators [enable email during installation or upgrade](/guide/platform/installation/credentials#enable-email).

Each project on an email-enabled platform has:

- **Default sender:** `<your-slug>+noreply@<mail-domain>`. Older projects with slugs longer than 56 characters must pass `from` explicitly.
- **Your account email as a recipient:** it is registered when the project is created. If Cloudflare has not verified it for the platform, follow the emailed verification link and run `void email destinations` before sending to it.

The shared sender can send only to verified recipients. Verify your own address or [add another recipient](#adding-recipients) before sending.

Deploying to your own Cloudflare account instead (`void deploy --platform cloudflare`) requires a sender in `void.config.ts` and email setup — see [Your own Cloudflare account](./domains.md#your-own-cloudflare-account).

## Adding recipients {#adding-recipients}

Cloudflare's `send_email` binding only delivers to addresses you've registered as recipients. Add them with the CLI:

```sh
void email allow user@acme.com
```

Cloudflare emails the recipient with a verification link. Once they click it and `void email destinations` has picked the click up, you can send to that address from your project. If the link did not arrive or has expired, run `void email allow <address>` again while the address is still pending — the CLI re-sends the link, or tells you how to get a fresh one. List the project's recipients:

```sh
void email destinations
```

::: warning When this is the right fit
The shared sender suits team alerts, project notifications, and replies to inbound mail.

For mail to arbitrary users, [register your own domain](./domains.md#your-own-domain-on-the-platform), use [Workers Paid on your own Cloudflare account](./domains.md#your-own-cloudflare-account), or call another email provider from your handler.
:::

## Options {#options}

| Option           | Type                         | Notes                                                                                                           |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `from`           | `string \| { email, name? }` | Optional. Pinned to the project sender — see below.                                                             |
| `to`             | `Address \| Address[]`       | Required. One or more recipients.                                                                               |
| `subject`        | `string`                     | Required. UTF-8 supported (encoded as RFC 2047).                                                                |
| `text`           | `string`                     | At least one of `text` / `html` is required.                                                                    |
| `html`           | `string`                     | Sent as `multipart/alternative` if both are provided.                                                           |
| `replyTo`        | `Address`                    | Optional `Reply-To` header.                                                                                     |
| `cc`, `bcc`      | `Address \| Address[]`       | Optional. Each recipient is sent its own message envelope.                                                      |
| `headers`        | `Record<string, string>`     | Custom headers; reserved headers (From, Date, etc.) are ignored.                                                |
| `attachments`    | `Attachment[]`               | See [Attachments](#attachments).                                                                                |
| `idempotencyKey` | `string`                     | Optional on the Void Platform: 1–128 printable, non-space ASCII characters. Reuse for retries of the same send. |

You can send to at most 50 recipients across `to`, `cc`, and `bcc`. Use standard email addresses with ASCII local parts, and punycode for internationalized domains.

`Address` accepts either a string (`"hello@acme.dev"` or `"Name <hello@acme.dev>"`) or an object (`{ email, name? }`). Unicode display names are supported.

On the platform the sender is pinned to your project. `from` must be your project's own platform address — `<project-slug>@<mail-domain>` or `<project-slug>+<tag>@<mail-domain>`, optionally with a display name — or any address on a domain registered with `void email domain add` (see [Your own domain on the platform](./domains.md#your-own-domain-on-the-platform)). For example, if your platform's mail domain is `mail.example.com`, you can use `Acme <acme+noreply@mail.example.com>`. Anything else is rejected with `INVALID_FROM`. Omit `from` and Void fills in `<project-slug>+noreply@<mail-domain>` for you. If the project owner set an [email alias](../../reference/cli/email.md#void-email-alias), `<alias>@<mail-domain>` and `<alias>+<tag>@<mail-domain>` are accepted too; the default stays the slug address.

On your own Cloudflare account, `from` defaults to `email.from` from `void.config.ts` and must be on a domain your account can send from; Cloudflare rejects any other sender and `sendEmail` reports it as `INVALID_FROM`.

## Attachments {#attachments}

```ts
await sendEmail({
  to: 'user@example.com',
  subject: 'Your receipt',
  text: 'Receipt attached.',
  attachments: [
    {
      filename: 'receipt.pdf',
      content: pdfBytes, // string | Uint8Array | ArrayBuffer | Blob
      contentType: 'application/pdf',
    },
  ],
});
```

For inline images (e.g. logos referenced from HTML), set `disposition: 'inline'` and `contentId`:

```ts
await sendEmail({
  to: 'user@example.com',
  subject: 'Hello',
  html: '<img src="cid:logo" alt="Acme">',
  attachments: [
    {
      filename: 'logo.png',
      content: logoBytes,
      contentType: 'image/png',
      contentId: 'logo',
      disposition: 'inline',
    },
  ],
});
```

Void infers `contentType` from the filename if you omit it. An explicit value must be a valid media type. `contentId` names the image referenced by `cid:<id>` in HTML; use an ID such as `logo` or `logo@acme.dev`. The encoded message is limited to 5 MiB and custom headers to 16 KiB. Invalid attachment fields or oversized messages return `MIME_ERROR`.

## Result and errors {#result-and-errors}

`sendEmail` returns a result instead of throwing. A successful result means the provider accepted the send; it does not confirm delivery to the recipient's mailbox.

`ok: true` includes recipient IDs. A failed result has either a request-level `error` or per-recipient `deliveries`. Platform results include an `operationId` when available.

A timeout can return `OUTCOME_UNKNOWN`; the provider may still accept the message. Inspect the outcome before retrying.

Use an idempotency key for sends you may retry:

```ts
const result = await sendEmail({
  to: 'user@example.com',
  subject: 'Invoice ready',
  text: 'Your invoice is available in your account.',
  idempotencyKey: 'invoice:42:ready',
});

if (result.ok) {
  console.log('Accepted by the provider', result.operationId);
} else {
  console.log('Inspect the outcome before retrying', result.operationId, result);
}
```

For 30 days, repeating a key with the same payload returns its recorded outcome without another provider submission. Reusing it with a different payload returns `IDEMPOTENCY_CONFLICT`. A lost response or interrupted provider request can return `OUTCOME_UNKNOWN`; check `void email logs` or repeat the same key. A new key creates a new send and can produce a duplicate. Native Cloudflare binding sends do not support platform idempotency keys.

| Code                     | Meaning                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `BINDING_MISSING`        | No email transport is configured.                              |
| `INVALID_FROM`           | The sender is invalid or not authorized for the project.       |
| `INVALID_TO`             | The recipient list is invalid or exceeds 50 recipients.        |
| `UNVERIFIED_DESTINATION` | The recipient needs verification under the active policy.      |
| `MIME_ERROR`             | The message is invalid or exceeds a size limit.                |
| `QUOTA_EXCEEDED`         | A platform or provider quota has been reached.                 |
| `IDEMPOTENCY_CONFLICT`   | The key was already used for another payload.                  |
| `OUTCOME_UNKNOWN`        | The send may have reached the provider; do not blindly resend. |
| `UPSTREAM_ERROR`         | The provider or platform refused the request.                  |

The default platform allowance is 200 recipient attempts per UTC month and 10 per rolling minute. Failed or uncertain attempts can count toward these limits. Check `void email usage` for your current allowance.

`void email usage` shows monthly recipient attempts, inbound receipts, and the remaining allowance. `void email logs --limit 50` shows up to 100 recent metadata entries retained for 30 days: operation, recipient, direction, state, provider reference, and error code. It does not store subjects, bodies, or attachments. Receiving a message and sending a reply are separate events.

## Local development {#local-development}

During local development, sends are captured to an in-memory inbox instead of going to Cloudflare. The dev server prints the inbox URL when it starts:

```
[void] Email inbox: http://localhost:5173/__void/inbox?token=<printed-token>
```

Open a message to preview its HTML, inspect attachments, or download it as an `.eml` file.

Every inbox route requires a local access token. Void includes it in the printed inbox URL and browser links. For command-line requests, send it in the `x-void-dev-trigger` header as shown below; requests without it return `401`. The token is stored in `.void/dev-trigger-token`. Treat inbox URLs as credentials, especially when exposing your dev server to a network.

```bash
# download a message as .eml
curl http://localhost:5173/__void/inbox/<id>/raw \
  -H "x-void-dev-trigger: <printed-token>" -o message.eml

# clear the inbox
curl -X DELETE http://localhost:5173/__void/inbox \
  -H "x-void-dev-trigger: <printed-token>"
```

The inbox keeps the most recent 100 messages through HMR and clears on a full server restart.

The dev inbox works in native Void apps, TanStack Start, and React Router. It is unavailable in SvelteKit, Nuxt, Analog, and Astro; sends from those apps return `BINDING_MISSING`. Use `createEmailTestHarness` from `void/email/testing` to capture sends in tests. If a configured inbox cannot be reached, `sendEmail` returns `UPSTREAM_ERROR` without sending.

`sendInDev` is deprecated. During local development it skips the inbox and returns `BINDING_MISSING`, so it never delivers. Remove it, and deploy the app to test real delivery.

## Testing {#testing}

Use the test harness to assert on outgoing messages without mocking the binding:

```ts
import { describe, it, expect } from 'vitest';
import { sendEmail } from 'void/email';
import { createEmailTestHarness } from 'void/email/testing';

describe('signup flow', () => {
  it('sends a welcome email', async () => {
    const inbox = createEmailTestHarness();

    await sendEmail({
      from: 'acme+noreply@mail.example.com', // use your project sender
      to: 'user@example.com',
      subject: 'Welcome',
      text: 'Hi!',
    });

    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].subject).toBe('Welcome');
    inbox.dispose();
  });
});
```

The harness intercepts every `sendEmail` call until `dispose()` is called. `clear()` empties the captured list without releasing the sink.

To handle incoming messages, see [Receiving Email](./receiving.md).

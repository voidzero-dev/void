---
outline: deep
---

<script setup>
import LegacyDocRedirect from '../../.vitepress/theme/LegacyDocRedirect.vue';
import links from '../../.vitepress/redirects/guide-email.json';
</script>

<LegacyDocRedirect page="guide/email.md" :links="links" />

# Email

Use Void to send transactional email, receive messages in route handlers, and test outgoing mail in a local inbox.

| Guide                                   | Use it for                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| [Sending Email](./email/sending.md)     | Send messages and attachments, handle errors, and test delivery locally.     |
| [Receiving Email](./email/receiving.md) | Route incoming messages, reply, forward, and test handlers.                  |
| [Domains and Setup](./email/domains.md) | Register a domain on your platform or configure your own Cloudflare account. |

On an email-enabled Void platform, start with its [shared sender](./email/sending.md#setup). For a direct Cloudflare deployment, [configure a sender and domain](./email/domains.md#your-own-cloudflare-account) first.

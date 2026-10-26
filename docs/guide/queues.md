---
outline: deep
---

# Queues

Use queues to process work asynchronously, such as sending emails or handling uploads. Define a consumer in `queues/`, then send it typed messages from your app.

## Defining queues

Create a consumer in `queues/`. TypeScript and JavaScript files are supported (`.ts`, `.mts`, `.js`, `.mjs`). Its path determines the queue name: `queues/emails.ts` creates `emails`, and `queues/order/notifications.ts` creates `order-notifications`. Each queue must have a unique name.

The resulting name must follow Cloudflare's queue naming rules: 1–63 characters, only letters, digits, and `-`, beginning and ending with a letter or digit. On `void deploy --platform cloudflare`, the Cloudflare queue also carries the Worker name, so the limit applies to that full name; see [Cloudflare queue names](#cloudflare-queue-names).

Export a default handler wrapped with [`defineQueue<T>`](../reference/api/handlers.md#definequeue-t-handler). `T` defines the message body for both the consumer and calls to `send()`:

```ts
// queues/emails.ts
import { defineQueue } from 'void';

interface Message {
  to: string;
  subject: string;
}

export default defineQueue<Message>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
    msg.ack(); // Acknowledge successful processing
  }
});
```

Files or directories starting with `_` are ignored.

## Sending messages

Import the typed `queues` proxy from `void/queues` to send messages. Each queue is available as a property matching its name, with full type safety from the consumer's `defineQueue<T>` generic.

```ts
// routes/api/orders.ts
import { defineHandler } from 'void';
import { queues } from 'void/queues';

export const POST = defineHandler(async (c) => {
  const order = await c.req.json();
  // Fully typed: body must match the
  // Message interface from queues/emails.ts
  await queues.emails.send({
    to: order.email,
    subject: 'Order confirmed',
  });
  return c.json({ ok: true });
});
```

## Per-message acknowledgment

Each message in the batch has `ack()` and `retry()` methods matching the [Cloudflare Queues API](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/):

```ts
export default defineQueue<Message>(async (batch, env) => {
  for (const msg of batch.messages) {
    try {
      await processMessage(msg.body);
      msg.ack(); // Remove from queue
    } catch {
      msg.retry({ delaySeconds: 30 }); // Re-deliver after 30s
    }
  }
});
```

- `msg.ack()`: acknowledge the message and remove it from the queue
- `msg.retry(options?)`: retry the message, optionally with a `{ delaySeconds }` delay
- `batch.ackAll()`: acknowledge all messages in the batch
- `batch.retryAll(options?)`: retry all messages in the batch

The first call wins for each message. Calling `ack()` after `retry()`, or the reverse, does nothing. Messages with no explicit decision are acknowledged if the handler succeeds, or retried if it throws.

The `timestamp` field on each message is a `Date` object.

## Consumer options

Export named constants to configure how Cloudflare delivers batches to your consumer:

```ts
// queues/emails.ts
import { defineQueue } from 'void';

interface Message {
  to: string;
  subject: string;
}

export const maxBatchSize = 50;
export const maxBatchTimeout = 10; // seconds
export const maxRetries = 5;
export const retryDelay = 30; // seconds

export default defineQueue<Message>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
  }
});
```

- `maxBatchSize`: maximum number of messages per batch (default `10`)
- `maxBatchTimeout`: maximum seconds to wait before delivering an incomplete batch (default `5`)
- `maxRetries`: maximum number of retries before delivery is exhausted (default `3`)
- `retryDelay`: seconds to wait between retries (default `0`)

Void-managed queues do not configure a dead-letter queue. Cloudflare permanently
deletes messages that exhaust their retries without one; see
[Cloudflare's dead-letter queue guide](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).

Void provisions queues and connects their producers and consumers when you deploy.

### Cloudflare queue names

Queue names are unique per Cloudflare account. So `void deploy --platform cloudflare` names each queue after the Worker: in a Worker named `app-staging`, `queues/jobs.ts` uses the Cloudflare queue `app-staging-jobs` (a `_` in the Worker name becomes `-`). Two Workers in one account, such as `app-staging` and `app-production`, get separate queues. Your code keeps using the name from `queues/` (`queues.jobs.send()`), and `vp dev` uses that name too.

The deploy stops before creating anything when:

- a new queue's full name is longer than 63 characters. Shorten the Worker name or the file name.
- one queue's full name is the name of another file in `queues/`, such as `queues/jobs.ts` and `queues/app-jobs.ts` in Worker `app`. Rename one of the files.
- another Worker already consumes the Cloudflare queue the deploy would use. A Cloudflare queue has one consumer.

A queue that the Worker already consumes keeps its name, so an app deployed before Worker-named queues keeps its queue (for example `jobs`) and the messages in it. The deploy prints a note when it keeps a name. To move to the Worker-named queue, remove the Worker's consumer from the old queue in the Cloudflare dashboard, then deploy again. Messages that reach the old queue before that deploy finishes stay there, so do this when the app is not sending messages, and check that the old queue is empty before you delete it.

## Local development

In native Void apps, sending a message through a queue binding automatically invokes the consumer in Miniflare. Local delivery uses the same handler as production.

You can also manually dispatch a batch by POSTing to the dev endpoint Void exposes:

```
POST /__void/queue
Content-Type: application/json
{ "queue": "<queue-name>", "messages": [{ "id": "1", "timestamp": <unix_ms>, "body": <any>, "attempts": 1 }] }
```

The endpoint requires a local dev trigger token. Void prints a paste-ready curl command with the current token when the dev server starts.

```bash
curl -X POST http://localhost:5173/__void/queue \
  -H "Content-Type: application/json" \
  -H "x-void-dev-trigger: <printed-token>" \
  -d '{"queue":"my-queue","messages":[{"id":"1","timestamp":'"$(date +%s000)"',"body":{"hello":"world"},"attempts":1}]}'
```

In supported meta-frameworks, use `/__void/queue` to test a consumer manually. It runs inside the framework adapter's development runtime with that adapter's bindings. Sending to a queue binding doesn't automatically invoke the consumer in this mode.

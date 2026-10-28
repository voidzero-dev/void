---
outline: deep
---

# Live Event Streams

`void/live` lets a browser subscribe to several topics over one SSE connection. Publish an event from a route, scheduled job, or queue consumer, and Void delivers it to connected subscribers using Durable Objects.

For example, a page can subscribe to updates for a post and its comments, then change those subscriptions as the user navigates. If a single request produces the whole stream, such as an AI response, [`void/sse`](./sse.md) is enough.

## Define A Stream

Define a stream in a server-only module:

```ts
// src/live.ts
import { defineLiveStream } from 'void/live';

export const live = defineLiveStream({
  id: 'app',
  allowAnonymousControl: true,
});
```

This example accepts visitors who are not signed in. Without `onSubscribe`, any connection can subscribe to any topic, so read [Authorization](#authorization) before you publish private data.

Void enables live streams when a [scanned file](../reference/resource-inference.md#scanned-directories) imports `void/live`, so keep this module in `src/` or another scanned directory. To keep it in an unscanned directory such as `lib/`, add that directory to [`inference.scanDirs`](../reference/resource-inference.md#custom-scan-directories) and list the default directories you still use, because `scanDirs` replaces them.

Expose it from a normal route:

```ts
// routes/live.ts
import { defineHandler } from 'void';
import { live } from '../src/live';

export const GET = defineHandler((c) => live.connect(c));
export const POST = defineHandler((c) => live.control(c));
```

`GET` opens the SSE connection. `POST` accepts subscribe and unsubscribe control
operations for that connection.

## Subscribe From The Browser

Use the browser helper from `void/live/client`:

```ts
import { connectLiveStream } from 'void/live/client';

const stream = connectLiveStream('/live', {
  withCredentials: true,
  retryDelay: 1_000,
  onError(error) {
    console.error(error);
  },
});

const unsubscribePost = await stream.subscribe({
  id: 'post-card',
  topic: 'post:12',
  onEvent(event) {
    if (event.type === 'updated') {
      console.log(event.data);
    }
  },
});

const unsubscribeComments = await stream.subscribe({
  id: 'comments',
  topic: 'comment:2323',
});

await unsubscribeComments();
await unsubscribePost();
stream.close();
```

Subscription IDs are scoped to a connection. Reusing an ID replaces its subscription. After reconnecting, the helper restores active subscriptions and sends their latest `eventId` as `lastEventId`.

## Publish

Publish from any server-side code that has a Void runtime env:

```ts
import { live } from '../src/live';

await live.publish(
  'post:12',
  { title: 'Updated title' },
  { type: 'updated', eventId: 'post-12-v8' },
);
```

Choose your own topic names and JSON payloads. Void includes `type` and `eventId` in the event envelope without interpreting or storing them. It doesn't use native SSE `id` fields.

If you are outside an active request/runtime context, pass env explicitly:

```ts
await live.withEnv(env).publish('post:12', { title: 'Updated title' });
```

## Authorization

Only a connection's owner can change its subscriptions. The example above allows anonymous connections; authenticated streams use the current Void user by default.

The owner decides who can change a connection's subscriptions, not which topics the connection can read.

For authenticated streams, pass the same owner key to `connect()` and
`control()`:

```ts
return live.connect(c, { owner: `user:${session.userId}` });
return live.control(c, { owner: `user:${session.userId}` });
```

If every route should derive ownership the same way, define it once with
`identifyConnection`:

```ts
export const live = defineLiveStream({
  id: 'app',
  async identifyConnection(ctx) {
    const session = await getSession(ctx.request);
    return session ? `user:${session.userId}` : null;
  },
});
```

When `identifyConnection` returns `null` or `undefined`, Void falls back to the
current authenticated user and uses `user:${user.id}` when the user has a string
`id`. If neither path produces an owner and `allowAnonymousControl` is not set,
the request is rejected with `403`.

Without `onSubscribe`, any connection that passes the owner check (any signed-in user, or any visitor when `allowAnonymousControl` is set) can subscribe to any topic and receives everything published to it. Topic names are easy to guess. Use `onSubscribe` to decide who can read each topic: return a `Response` to reject the subscription, or return nothing to allow it.

```ts
export const live = defineLiveStream({
  id: 'app',
  async onSubscribe(ctx) {
    const post = /^post:(.+)$/.exec(ctx.topic);
    if (post && (await canReadPost(ctx.env, ctx.user, post[1]))) return;
    const inbox = /^user:(.+):inbox$/.exec(ctx.topic);
    if (inbox && ctx.owner === `user:${inbox[1]}`) return;
    return new Response('Forbidden', { status: 403 });
  },
});
```

## Limits

`void/live` is designed for small and medium fanout. By default, a stream allows:

- `256` active subscriptions per browser connection
- `256` active subscriptions per topic
- `100` subscribe or unsubscribe operations per control request
- `100` queued events per connection
- `64 KiB` per encoded event envelope

Each active topic supports up to 256 subscriptions, regardless of how many topic names your app uses. For example, `post:${postId}` gives each post its own subscriber limit. A user with two open tabs can count twice.

You can lower limits per stream:

```ts
export const live = defineLiveStream({
  id: 'app',
  limits: {
    maxSubscriptionsPerTopic: 64,
  },
});
```

`maxSubscriptionsPerTopic` cannot be raised above `256`. For larger broadcasts, split subscribers across application topics or use a dedicated realtime system.

## Delivery Semantics

Events are ordered within a topic and delivered at most once. Deploys, rollbacks, restarts, and reconnects can drop live state, so clients may miss events. Raw HTTP clients must resubscribe after reconnecting.

For replay, store events in your application and use `eventId` and `lastEventId` to resume. Void does not store events or manage client state.

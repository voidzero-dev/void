---
description: 'Send typed messages between the server and connected clients. Each route keeps its state in a Durable Object.'
outline: deep
---

# WebSockets

::: warning ⚠️ Void Apps Only
Typed WebSocket routes currently work in native Void apps. They aren't available in meta-framework mode yet.
:::

Create a `.ws.ts` route to send typed messages between your server and connected clients. Each route instance has its own Cloudflare Durable Object for shared state. WebSocket routes require the Cloudflare target.

For example, `/rooms/[id]` gives each chat room its own instance. Use it for chat, presence, collaborative documents, or notifications.

## Route files

Create WebSocket routes in `routes/` using `.ws.ts`, `.ws.tsx`, `.ws.js`, `.ws.jsx`, `.ws.mts`, or `.ws.mjs`:

```text
routes/
  chat/[room].ws.ts
  notifications.ws.ts
```

Use `.ws.tsx` or `.ws.jsx` when a handler contains JSX, such as rendering HTML fragments to send to connected clients. See [JSX handlers](./server-routing.md#jsx-handlers) for the JSX runtime.

Filename rules match regular server routes:

- `index.ws.ts` becomes the parent path
- `[id].ws.ts` adds a dynamic `[id]` segment
- `[...slug].ws.ts` becomes a catch-all
- route groups like `(marketing)/chat.ws.ts` are ignored in the URL
- `chat.dev.ws.ts` / `chat.prod.ws.ts` restrict the route to one environment

Place the environment suffix **before** `.ws`, as in `chat.dev.ws.ts`.

## `defineRoom()`

Use `defineRoom()` when clients should share a room or document identified by the route.

```ts
// routes/chat/[room].ws.ts
import * as v from 'valibot';
import { defineRoom } from 'void/ws';

const ClientMessage = v.variant('type', [
  v.object({ type: v.literal('chat.message'), text: v.string() }),
]);

const ServerMessage = v.variant('type', [
  v.object({
    type: v.literal('chat.message'),
    id: v.string(),
    text: v.string(),
    userId: v.string(),
  }),
  v.object({ type: v.literal('chat.joined'), userId: v.string() }),
]);

export default defineRoom({
  messages: {
    client: ClientMessage,
    server: ServerMessage,
  },
  onBeforeConnect(ctx) {
    if (!ctx.user) {
      return new Response('Unauthorized', { status: 401 });
    }
  },
  async onConnect(ctx) {
    await ctx.room.broadcast({ type: 'chat.joined', userId: ctx.user!.id }, [ctx.connection.id]);
  },
  async onMessage(ctx, event) {
    await ctx.room.broadcast({
      type: 'chat.message',
      id: crypto.randomUUID(),
      text: event.text,
      userId: ctx.user!.id,
    });
  },
});
```

`defineRoom()` adds room helpers to the hook context:

- `ctx.room.broadcast(event, excludeIds?)`
- `ctx.room.getConnections()`
- `ctx.room.getConnection(id)`
- `ctx.connection.send(event)`
- `ctx.connection.close(code?, reason?)`
- `ctx.connection.setState(data)`

Add `actions` when other server code should reach the room. See [Server-side actions](#server-side-actions).

## `defineWebSocket()`

Use `defineWebSocket()` when each connection is handled independently instead of as a shared room.

```ts
// routes/notifications.ws.ts
import * as v from 'valibot';
import { defineWebSocket } from 'void/ws';

export default defineWebSocket({
  messages: {
    client: v.object({ type: v.literal('notifications.ack'), id: v.string() }),
    server: v.object({ type: v.literal('notifications.item'), title: v.string() }),
  },
  onBeforeConnect(ctx) {
    if (!ctx.user) {
      return new Response('Unauthorized', { status: 401 });
    }
  },
  async onConnect(ctx) {
    await ctx.socket.send({ type: 'notifications.item', title: 'Connected' });
  },
});
```

## Client

Use `connect()` from `void/ws` on the client:

```ts
import { connect } from 'void/ws';

const socket = connect('/chat/[room]', {
  params: { room: 'general' },
});

socket.on('message', (event) => {
  if (event.type === 'chat.message') {
    console.log(event.text);
  }
});

socket.send({ type: 'chat.message', text: 'hello' });
```

`connect()` resolves relative URLs against the current origin and automatically uses `ws:` or `wss:`. It also buffers messages until the socket opens and reconnects by default.

## Typed messages

Define schemas for messages sent by the client and server:

- `messages.client` validates what the browser may send
- `messages.server` validates what the server may send
- `onMessage()` receives the parsed, validated client event
- `ctx.room.broadcast()`, `ctx.connection.send()`, and `ctx.socket.send()` are typed from `messages.server`
- `connect()` infers route params, outgoing client messages, and incoming server messages from generated route types

Messages are JSON events. Raw string and binary messages are not supported.

## Authentication

When Void auth is enabled, every WebSocket hook receives the current user as `ctx.user`, or `null` for an anonymous connection. Use `onBeforeConnect` to reject unauthenticated clients.

Connections from another origin are anonymous unless that origin is in your auth `trustedOrigins`. If you read your own cookies from `ctx.request` in `onBeforeConnect`, check its `Origin` header yourself.

`ctx.user` is resolved when the socket connects and stays the same for that connection, even if the user later signs out or the session is revoked. For actions that must respect a ban or role change, re-check your own records in `onMessage` and close the connection with `ctx.connection.close()` in rooms or `ctx.socket.close()` in `defineWebSocket()`. To close idle sockets as soon as a session is revoked, declare a [room action](#server-side-actions) and call it from the code that revokes the session.

## Server-side actions

A room can declare named actions that other server code calls with typed arguments. An action runs inside the room's Durable Object, so it can close matching connections or broadcast without waiting for the next client frame.

```ts
// routes/relay/[accountId].ws.ts
import * as v from 'valibot';
import { getSession } from 'void/auth';
import { defineRoom } from 'void/ws';

const ClientMessage = v.object({ type: v.literal('relay.ping') });
const ServerMessage = v.object({ type: v.literal('relay.message'), text: v.string() });

export default defineRoom({
  messages: { client: ClientMessage, server: ServerMessage },
  onConnect(ctx) {
    // The session comes from the request's authenticated session, not from client input.
    const session = getSession()?.session;
    if (session) {
      ctx.connection.setState({ sessionId: session.id });
    }
  },
  actions: {
    async revokeSession(ctx, sessionId: string, code: number) {
      let closed = 0;
      for (const connection of ctx.room.getConnections()) {
        const state = connection.state as { sessionId?: string } | undefined;
        if (state?.sessionId !== sessionId) continue;
        connection.close(code, 'session revoked');
        closed += 1;
      }
      return { closed };
    },
    async announce(ctx, text: string) {
      await ctx.room.broadcast({ type: 'relay.message', text });
    },
  },
});
```

Call the action from a route handler, an auth hook, a queue consumer or a cron job with `getRoom()` from `void/ws/server`:

```ts
import { getRoom } from 'void/ws/server';

// Better Auth's databaseHooks.session.delete.after, or any other server code
const room = getRoom('/relay/[accountId]', { params: { accountId } });
const { closed } = await room.actions.revokeSession(session.id, 4001);
```

Match connections on server-verified state. Do not store a session id read from the URL, a query string or a client message: a client can send any value, so the revocation would close the wrong sockets and leave the real ones open. Derive the value from `getSession()` or your own records, and pass that same verified id from the code that revokes it.

- `getRoom()` addresses the same instance `connect()` reaches. Pass the route pattern and the same params; a custom `key` is applied too.
- Arguments and results are typed from the definition. Annotate each action parameter, because unannotated parameters are inferred as `never`.
- Actions receive `ctx.id`, `ctx.params`, `ctx.env`, `ctx.storage` and `ctx.room`. There is no `ctx.request` or `ctx.user`: the caller is other server code, so authorize the decision where it is made.
- Inside an action, `ctx.room.broadcast()` and connection `send()` accept any event. The server message schema still validates the event at runtime.
- Arguments cross a Durable Object boundary. Pass structured-clone data, not callbacks or class instances.
- Unknown action names and handler errors reject the call. An unknown route, a `defineWebSocket()` route or a missing param throws before any Durable Object is contacted.
- Do not call an action from the same room's own hooks. Use `ctx.room` there; a call from inside the room waits on the room itself.

Actions are not an endpoint. They are invoked over Durable Object RPC from your Worker, so a browser request or a WebSocket message cannot call one. A room without `onRequest()` still answers ordinary HTTP requests to its path with `426 Upgrade Required`.

`getRoom()` reads the current runtime env, so it works in any handler Void runs, including a route, a queue consumer, a cron job and an auth hook that runs inside one. In code that runs outside one, pass the bindings object you already hold:

```ts
getRoom('/relay/[accountId]', { params: { accountId }, env: bindings });
```

`defineWebSocket()` routes have no actions. Actions are available in native Void apps only.

## Hooks

Both `defineRoom()` and `defineWebSocket()` support:

- `onBeforeConnect(ctx)`: return a `Response` to reject the upgrade
- `onConnect(ctx)`: runs after the socket is accepted
- `onMessage(ctx, event)`: receives the validated client event
- `onClose(ctx, details)`: receives `{ code, reason, wasClean }`
- `onRequest(ctx)`: handles ordinary HTTP requests to the same path

Void completes the WebSocket close handshake automatically. Use `onClose` for application cleanup;
you do not need to close the socket again in this hook.

Every hook receives a context with:

- `ctx.id`: deterministic route instance id
- `ctx.params`: matched route params
- `ctx.user`: resolved auth user or `null`
- `ctx.request`: the HTTP request in `onBeforeConnect`, `onConnect`, and `onRequest`. In `onMessage` and `onClose`, it is a placeholder without headers, cookies, or query. To keep request data, save it in `onConnect` with `ctx.connection.setState()` in rooms or `ctx.socket.setState()` in `defineWebSocket()`. Read it later from `ctx.connection.state` or `ctx.socket.state`.
- `ctx.env`
- `ctx.storage`

If a route does not define `onRequest()`, non-WebSocket requests return `426 Upgrade Required`.

## Move a route while keeping its state

Before moving a deployed route, run `void info`. For `routes/chat/[room].ws.ts`, the output includes:

```text
To preserve this resource when moving its code, add this to 'defineRoom':
  name: "chat-room",
```

Add the displayed name to your existing definition:

```ts
export default defineRoom({
  name: 'chat-room',
  messages: { client: ClientMessage, server: ServerMessage },
  // Keep your existing hooks.
});
```

Move the file to `routes/rooms/[room].ws.ts`, update clients to connect to `/rooms/[room]`, and deploy normally. Keep the same parameter names and values: room `general` still uses its existing storage. The Worker class, binding, and migration history stay the same on both Cloudflare and Void platform deployments.

Both `defineRoom()` and `defineWebSocket()` accept optional `name`. Use a static string, inline or in a local `const`. Each route must produce a distinct Worker class; changing the name selects a different resource. If you already moved a route, `void info` also shows unmatched identities recorded in `void.lock.json`. Identify the original resource before adopting its suggested name; otherwise restore the original source and discover the name there.

### Rename a route parameter

By default, the instance key includes parameter names. `/chat/[room]` with `room: 'general'` uses `room=general`; a route without parameters uses `default`. Multiple parameters are joined in route order, for example `team=acme&room=general`. If a multi-parameter route has a value containing `&`, its key uses a versioned encoding to keep rooms separate.

If you also rename `[room]` to `[id]`, preserve the old key explicitly:

```ts
// routes/rooms/[id].ws.ts
export default defineRoom({
  name: 'chat-room',
  key: ({ params }) => `room=${params.id}`,
  messages: { client: ClientMessage, server: ServerMessage },
  // Keep your existing hooks.
});
```

Clients now connect to `/rooms/[id]` with `params: { id: 'general' }`. The key remains `room=general`, so storage and `ctx.id` stay the same. Returning only `params.id` would select a different instance.

`key` is optional on both WebSocket helpers. It must return a string synchronously and consistently for the same parameters. Preserve the complete old key when migrating multiple parameters. Keep the callback stable after deployment.

## Constraints

Each socket connects to one route instance. To switch rooms, close the current connection and open another. For publishing to multiple topics, see [Live Event Streams](./live.md).

## Deployment

WebSocket routes work on Cloudflare and Void platform deployments. Commit `void.lock.json` when Void adds a binding or migration. Do not delete or reorder deployed migration steps.

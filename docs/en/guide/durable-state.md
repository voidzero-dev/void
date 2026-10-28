---
outline: deep
---

# Durable State

Use a Durable Object when requests need to share state under one name, such as a shopping cart, room, or rate limiter. Void gives you typed methods and stores the object's state between calls.

Create a module in `durable-objects/` with `defineDurableState()`. Void provides a SQLite-backed Cloudflare Durable Object for it. This feature supports native Void apps on Void platforms and direct Cloudflare deployments.

Commit `void.lock.json` when Void adds a resource. Keep its deployed migration entries in their original order.

## Define state and methods

```ts
// durable-objects/counter.ts
import { defineDurableState } from 'void/durable';

export const Counter = defineDurableState({
  initialState: { count: 0 },
  methods: {
    increment(context, amount: number) {
      context.state.count += amount;
      return context.state.count;
    },
    read(context) {
      return context.state.count;
    },
  },
});

export default Counter;
```

Default-export the object returned by `defineDurableState()`.

## Call it from a route

Import your definition and call `get()` with a name to select an object. Method arguments and return values are typed:

```ts
// routes/api/counter.ts
import { defineHandler } from 'void';
import { Counter } from '../../durable-objects/counter';

export const POST = defineHandler(async () => {
  const counter = Counter.get('global');
  const count = await counter.increment(1);
  return { count };
});
```

The same name always resolves to the same Durable Object. Use `getById(id)` when you already have a `DurableObjectId`. For advanced cases, both helpers also accept an explicit `DurableObjectNamespace` as their first argument.

## Execution and persistence

Void loads state before the first operation and runs RPC methods one at a time. After a method, `fetch`, or `alarm` handler succeeds, it saves the updated state.

If the handler or save fails, Void restores `context.state` to its previous value. Direct writes to `context.storage` aren't included in that rollback.

Each method receives:

- `context.state`, which can be mutated or replaced
- `context.env`, the Durable Object environment
- `context.id` and `context.storage`
- `context.setAlarm()` and `context.deleteAlarm()`

Methods named `fetch`, `alarm`, or `constructor` are reserved. Define `fetch` and `alarm` as top-level hooks instead:

```ts
export const Room = defineDurableState({
  initialState: { wakeups: 0 },
  methods: {},
  fetch(context) {
    return Response.json(context.state);
  },
  async alarm(context) {
    context.state.wakeups += 1;
    await context.setAlarm(Date.now() + 60_000);
  },
});

export default Room;
```

## State migrations

Version the persisted value when its shape changes. Versions start at `1`, must be contiguous, and run in order before an operation handles the migrated state.

```ts
export const Counter = defineDurableState({
  initialState: { count: 0, label: 'Counter' },
  version: 2,
  migrations: [
    {
      version: 1,
      migrate(old) {
        return { count: (old as { count: number }).count, label: 'Counter' };
      },
    },
    {
      version: 2,
      migrate(old) {
        return { ...(old as { count: number; label: string }), label: 'Total' };
      },
    },
  ],
  methods: {
    read(context) {
      return context.state;
    },
  },
});

export default Counter;
```

State migrations update your saved values. Void manages Cloudflare’s separate class migrations in `void.lock.json`.

For direct Cloudflare deployments, do not delete or reorder generated Durable Object migrations in `void.lock.json` after deployment. For a class addition, rename, or removal on an existing Worker, review the migration and run `void deploy --platform cloudflare --atomic`. If this Worker needs atomic publication on every deploy, set `deploy: { cloudflare: { mode: 'atomic' } }` in `void.config.ts`. Cloudflare applies class lifecycle changes in one deployment. The Worker receives traffic before Void checks readiness, and you cannot roll back across that migration boundary. Staged deploys keep pre-traffic readiness verification.

## Rename a file while keeping its state

Before renaming a deployed definition, run:

```sh
void info
```

For `durable-objects/counter.ts`, Void prints:

```text
To preserve this resource when moving its code, add this to 'defineDurableState':
  name: "counter",
```

Add that property to the existing definition:

```ts
export const Counter = defineDurableState({
  name: 'counter',
  initialState: { count: 0 },
  methods: {
    read(context) {
      return context.state.count;
    },
  },
});

export default Counter;
```

Rename the file within `durable-objects/`, update its imports, and deploy. Keep `name: 'counter'` and the names passed to `Counter.get()` unchanged to preserve the stored state.

`name` is optional. Use a static string, either inline or in a local `const`, containing words that start with a letter, such as `'shopping-cart'`. Names must produce distinct Worker classes and bindings. Changing an existing resource's `name` selects a different resource.

If you already moved the file, `void info` also shows resources recorded in `void.lock.json` without a matching definition. Identify the original resource and use its suggested name. If no name can be suggested, restore the original file from source history and run `void info` before moving it again. Keep the existing lock and migration history.

## Deployment support

Typed state works in local development, on Void platforms, and in direct Cloudflare deploys of native Void apps. Use `void deploy` for a Void platform or `void deploy --platform cloudflare` for your own Cloudflare account.

On a Void platform, each class keeps its storage across deployments and rollbacks. A rollback restores the class code and keeps the current stored data. Removing a definition makes the class inactive; adding it again with the same resource name restores access to its data. Deleting the project deletes its Durable Object storage.

A project supports up to 32 distinct custom classes, including removed classes whose storage is retained. Keep resource names and instance names stable to preserve data. Upgrade an older Void installation before deploying an app that uses custom Durable Objects.

Custom Durable Object modules are not supported in meta-frameworks or on Node.js, Bun, and Deno.

This is separate from [typed WebSocket routes](./websockets.md), which also use SQLite-backed Durable Objects and work on both direct Cloudflare and hosted Void deployments.

## Native Durable Object classes

Use `defineDurableObject` to keep a native Cloudflare class, including classes extending Cloudflare Agents. Void discovers its binding and exports the class without replacing its constructor, lifecycle, or RPC methods. Like Durable State, this supports Void platforms and direct Cloudflare deployments.

```ts
// durable-objects/workspace.ts
import { DurableObject } from 'cloudflare:workers';
import { defineDurableObject } from 'void/durable';

class WorkspaceObject extends DurableObject {
  async fetch() {
    return new Response('Workspace');
  }
}

export const Workspace = defineDurableObject({
  name: 'workspace',
  class: WorkspaceObject,
});
export default Workspace;
```

Call `Workspace.get('project-id')` from a server handler to obtain its typed stub. Keep the resource name and instance name stable across deployments to retain storage.

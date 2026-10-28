---
outline: deep
---

# Durable State and WebSockets {#durable-state}

Imported from `"void/durable"`. See [Durable State](../../guide/durable-state.md) for the complete file convention and deployment support.

## `defineDurableState(definition)` {#definedurablestate-definition}

Defines a typed, persisted Durable Object state machine. The returned object must be the default export of a module under `durable-objects/`; named-export the same object for typed RPC calls elsewhere in the app.

```ts
function defineDurableState<TState, TEnv, TMethods>(definition: {
  name?: string;
  initialState: TState | ((env: TEnv) => TState | Promise<TState>);
  version?: number;
  migrations?: Array<{
    version: number;
    migrate(state: unknown): TState | Promise<TState>;
  }>;
  methods: TMethods;
  fetch?: (context, request: Request) => Response | Promise<Response>;
  alarm?: (context) => void | Promise<void>;
  storageKey?: string;
}): DurableStateApi<TMethods>;
```

`DurableStateApi` exposes `class`, `get(name)`, `get(namespace, name)`, `getById(id)`, and `getById(namespace, id)`. Stubs returned by the lookup helpers contain the definition's methods with their argument types preserved and return values wrapped in `Promise`.

`name` optionally fixes the persistent resource identity instead of deriving it from the filename. Run `void info` and pin the displayed name before renaming a deployed definition. Keep instance names passed to `get()` unchanged. See the [migration flow](../../guide/durable-state.md#rename-a-file-while-keeping-its-state).

## WebSockets {#websockets}

Imported from `"void/ws"`. `defineRoom()` adds shared-room helpers to hook contexts; `defineWebSocket()` supplies a connection's socket helpers. Both require `messages.client` and `messages.server` Standard Schema validators and support the hooks described in the [WebSocket guide](../../guide/websockets.md).

Both helpers accept these optional resource settings:

```ts
name?: string;
key?: (context: { params: Record<string, string> }) => string;
```

`name` fixes the Worker class and binding identity. Without it, Void derives the identity from the route file. Run `void info` before moving a deployed route and pin its displayed name.

`key` selects the route instance and its `ctx.id`. Without it, routes use parameter names and values in route order (`room=general`, or `default` without parameters). A callback must return a stable string synchronously. When renaming parameters, preserve the complete old key to retain state. See [moving routes](../../guide/websockets.md#move-a-route-while-keeping-its-state) and [renaming parameters](../../guide/websockets.md#rename-a-route-parameter).

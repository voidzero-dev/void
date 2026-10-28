---
outline: deep
---

# 持久化状态与 WebSocket {#durable-state}

从 `"void/durable"` 导入。完整的文件约定和部署支持，见[持久化状态](/zh/guide/durable-state)。

## `defineDurableState(definition)` {#definedurablestate-definition}

定义类型化、可持久化的 Durable Object 状态机。返回的对象必须是 `durable-objects/` 下某个模块的默认导出；同时以具名方式导出该对象，便可在应用的其他位置进行类型化 RPC 调用。

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

`DurableStateApi` 提供 `class`、`get(name)`、`get(namespace, name)`、`getById(id)` 和 `getById(namespace, id)`。查询辅助函数返回的代理对象（stub）包含定义中的方法。这些方法保留原有的参数类型，返回值会包装为 `Promise`。

可选的 `name` 用于固定持久化资源的标识，而不是根据文件名推导。重命名已部署的定义前，先运行 `void info` 并固定输出的名称。传给 `get()` 的实例名称也应保持不变。见[迁移流程](/zh/guide/durable-state#rename-a-file-while-keeping-its-state)。

## WebSocket {#websockets}

从 `"void/ws"` 导入。`defineRoom()` 为钩子上下文添加共享房间辅助方法，`defineWebSocket()` 则提供单个连接的 socket 辅助方法。两者都要求为 `messages.client` 和 `messages.server` 提供 Standard Schema 校验器，并支持 [WebSocket 指南](/zh/guide/websockets)中的钩子。

两个辅助函数都接受以下可选资源设置：

```ts
name?: string;
key?: (context: { params: Record<string, string> }) => string;
```

`name` 固定 Worker 类和绑定的标识。未提供时，Void 会根据路由文件推导。移动已部署的路由前，先运行 `void info` 并固定输出的名称。

`key` 用于选择路由实例及其 `ctx.id`。未提供时，路由会按路径中的顺序组合参数名称和值，例如 `room=general`；没有参数时使用 `default`。回调必须同步返回稳定的字符串。重命名参数时，应保留完整的旧键，以保留状态。见[移动路由](/zh/guide/websockets#move-a-route-while-keeping-its-state)和[重命名参数](/zh/guide/websockets#rename-a-route-parameter)。

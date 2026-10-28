---
outline: deep
---

# WebSockets {#websockets}

::: warning ⚠️ 仅适用于 Void 应用
类型化 WebSocket 路由目前仅适用于原生 Void 应用，尚不支持元框架模式。
:::

创建 `.ws.ts` 路由，即可在服务端和已连接的客户端之间发送带类型的消息。每个路由实例都有独立的 Cloudflare Durable Object 来保存共享状态。WebSocket 路由要求使用 Cloudflare 目标。

例如，`/rooms/[id]` 会为每个聊天室提供独立实例。你可以用它实现聊天、在线状态、协作文档或通知。

## 路由文件 {#route-files}

在 `routes/` 中创建 WebSocket 路由，使用 `.ws.ts`、`.ws.tsx`、`.ws.js`、`.ws.jsx`、`.ws.mts` 或 `.ws.mjs` 扩展名：

```text
routes/
  chat/[room].ws.ts
  notifications.ws.ts
```

如果处理函数包含 JSX，例如需要渲染 HTML 片段并发送给已连接的客户端，请使用 `.ws.tsx` 或 `.ws.jsx`。有关 JSX 运行时的说明，请参阅 [JSX 处理函数](/zh/guide/server-routing#jsx-handlers)。

文件名规则与普通服务端路由相同：

- `index.ws.ts` 对应父级路径
- `[id].ws.ts` 对应 `:id`
- `[...slug].ws.ts` 匹配所有剩余路径
- `(marketing)/chat.ws.ts` 这类路径中的路由组名称不会出现在 URL 中
- `chat.dev.ws.ts` / `chat.prod.ws.ts` 将路由限制在对应环境中

环境后缀必须放在 `.ws` **之前**。`chat.ws.dev.ts` 不会被识别为 WebSocket 路由。

## `defineRoom()` {#defineroom}

如果客户端需要共享由路由标识的房间或文档，请使用 `defineRoom()`。

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

`defineRoom()` 会在钩子上下文中添加房间辅助方法：

- `ctx.room.broadcast(event, excludeIds?)`
- `ctx.room.getConnections()`
- `ctx.room.getConnection(id)`
- `ctx.connection.send(event)`
- `ctx.connection.close(code?, reason?)`
- `ctx.connection.setState(data)`

## `defineWebSocket()` {#definewebsocket}

如果每条连接需要独立处理，而非共享房间，请使用 `defineWebSocket()`。

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

## 客户端 {#client}

在客户端使用 `void/ws` 提供的 `connect()`：

```ts
import { connect } from 'void/ws';

const socket = connect('/chat/:room', {
  params: { room: 'general' },
});

socket.on('message', (event) => {
  if (event.type === 'chat.message') {
    console.log(event.text);
  }
});

socket.send({ type: 'chat.message', text: 'hello' });
```

`connect()` 会基于当前源解析相对 URL，并自动使用 `ws:` 或 `wss:`。它会在连接建立前缓存消息，并默认在断开后重连。

## 类型化消息 {#typed-messages}

为客户端和服务端发送的消息定义 schema：

- `messages.client` 校验浏览器可以发送的消息
- `messages.server` 校验服务端可以发送的消息
- `onMessage()` 接收已解析并通过校验的客户端事件
- `ctx.room.broadcast()`、`ctx.connection.send()` 和 `ctx.socket.send()` 的类型由 `messages.server` 决定
- `connect()` 根据生成的路由类型推导路由参数、客户端发送的消息和服务端传入的消息

消息以 JSON 事件传递，不支持原始字符串和二进制消息。

## 身份认证 {#authentication}

启用 Void 身份认证后，每个 WebSocket 钩子都可以通过 `ctx.user` 访问当前用户；匿名连接的该值为 `null`。使用 `onBeforeConnect` 可以拒绝未认证的客户端。

来自其他源的连接会被视为匿名连接，除非该源已列入身份认证配置的 `trustedOrigins`。如果你在 `onBeforeConnect` 中从 `ctx.request` 读取自己的 Cookie，请自行检查请求的 `Origin` 头。

`ctx.user` 在连接建立时解析，并在该连接存续期间保持不变，即使用户之后退出登录或会话被撤销也不会更新。对于必须响应封禁或角色变化的操作，请在 `onMessage` 中重新检查你自己的记录。需要关闭连接时，房间中使用 `ctx.connection.close()`，`defineWebSocket()` 中使用 `ctx.socket.close()`。

## 钩子 {#hooks}

`defineRoom()` 和 `defineWebSocket()` 均支持以下钩子：

- `onBeforeConnect(ctx)`：返回 `Response` 可以拒绝升级请求
- `onConnect(ctx)`：连接被接受后执行
- `onMessage(ctx, event)`：接收通过校验的客户端事件
- `onClose(ctx, details)`：接收 `{ code, reason, wasClean }`
- `onRequest(ctx)`：处理相同路径上的普通 HTTP 请求

Void 会自动完成 WebSocket 关闭握手。请在 `onClose` 中清理应用资源，无需在此钩子中再次关闭连接。

每个钩子都会收到包含以下内容的上下文：

- `ctx.id`：确定性的路由实例 ID
- `ctx.params`：匹配到的路由参数
- `ctx.user`：解析得到的认证用户，或 `null`
- `ctx.request`：在 `onBeforeConnect`、`onConnect` 和 `onRequest` 中为实际 HTTP 请求；在 `onMessage` 和 `onClose` 中则是不包含请求头、Cookie 或查询参数的占位请求。要保留请求数据，请在 `onConnect` 中保存：房间中使用 `ctx.connection.setState()`，`defineWebSocket()` 中使用 `ctx.socket.setState()`。之后通过 `ctx.connection.state` 或 `ctx.socket.state` 读取。
- `ctx.env`
- `ctx.storage`

如果路由未定义 `onRequest()`，非 WebSocket 请求会返回 `426 Upgrade Required`。

## 移动路由并保留状态 {#move-a-route-while-keeping-its-state}

移动已部署的路由前，请先运行 `void info`。对于 `routes/chat/[room].ws.ts`，输出会包含：

```text
To preserve this resource when moving its code, add this to 'defineRoom':
  name: "chat-room",
```

将显示的名称添加到现有定义中：

```ts
export default defineRoom({
  name: 'chat-room',
  messages: { client: ClientMessage, server: ServerMessage },
  // Keep your existing hooks.
});
```

将文件移动到 `routes/rooms/[room].ws.ts`，更新客户端，使其连接到 `/rooms/:room`，然后正常部署。保持参数名称和值不变，房间 `general` 就会继续使用已有存储。无论部署到 Cloudflare 还是 Void 平台，Worker 类、绑定和迁移历史都会保持不变。

`defineRoom()` 和 `defineWebSocket()` 都接受可选的 `name`。请使用静态字符串，可以直接写在定义中，也可以定义为局部 `const`。每个路由必须生成不同的 Worker 类；修改名称会选择另一个资源。如果已经移动了路由，`void info` 还会显示 `void.lock.json` 中记录但未匹配到的资源标识。采用建议名称前，请先确认原来的资源；如果无法确认，请恢复原始源码，再从中获取名称。

### 重命名路由参数 {#rename-a-route-parameter}

默认情况下，实例键包含参数名称。`/chat/:room` 中的 `room: 'general'` 使用 `room=general`；没有参数的路由使用 `default`。多个参数按路由中的顺序连接，例如 `team=acme&room=general`。如果多参数路由的某个值包含 `&`，实例键会使用带版本的编码，以区分不同房间。

如果还要将 `[room]` 重命名为 `[id]`，请显式保留原来的键：

```ts
// routes/rooms/[id].ws.ts
export default defineRoom({
  name: 'chat-room',
  key: ({ params }) => `room=${params.id}`,
  messages: { client: ClientMessage, server: ServerMessage },
  // Keep your existing hooks.
});
```

客户端现在通过 `params: { id: 'general' }` 连接到 `/rooms/:id`。实例键仍然是 `room=general`，因此存储和 `ctx.id` 都保持不变。如果只返回 `params.id`，则会选择另一个实例。

两个 WebSocket 辅助函数都支持可选的 `key`。它必须同步返回字符串，而且相同参数必须始终得到相同的结果。迁移多个参数时，请保留完整的旧键。部署后，请保持该回调稳定。

## 约束 {#constraints}

每条连接对应一个路由实例。要切换房间，请关闭当前连接，再建立新连接。要向多个主题发布事件，请参阅[实时事件流](/zh/guide/live)。

## 部署 {#deployment}

WebSocket 路由支持部署到 Cloudflare 和 Void 平台。Void 添加绑定或迁移后，请提交 `void.lock.json`。请勿删除已部署的迁移步骤，或调整其顺序。

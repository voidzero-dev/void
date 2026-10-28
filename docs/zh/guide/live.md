---
outline: deep
---

# 实时事件流 {#live-event-streams}

`void/live` 让浏览器通过一条 SSE 连接订阅多个主题。你可以从路由、定时任务或队列消费者中发布事件，Void 会通过 Durable Objects 将事件发送给已连接的订阅者。

例如，页面可以订阅一篇文章及其评论的更新，并随着用户导航调整订阅。如果整个事件流都由单次请求产生，例如 AI 响应，使用 [`void/sse`](/zh/guide/sse) 就足够了。

## 定义事件流 {#define-a-stream}

在仅供服务端使用的模块中定义事件流：

```ts
// src/live.ts
import { defineLiveStream } from 'void/live';

export const live = defineLiveStream({
  id: 'app',
  allowAnonymousControl: true,
});
```

此示例允许未登录的访客连接。如果未设置 `onSubscribe`，任何连接都可以订阅任意主题，因此在发布私有数据前，请先阅读[授权](#authorization)一节。

当[扫描范围内的文件](/zh/reference/resource-inference#scanned-directories)导入 `void/live` 时，Void 就会启用实时事件流。因此，请将此模块放在 `src/` 或其他扫描目录中。如果希望放在 `lib/` 等默认不扫描的目录中，请将该目录添加到 [`inference.scanDirs`](/zh/reference/resource-inference#custom-scan-directories)，并一并列出仍在使用的默认目录，因为 `scanDirs` 会替换默认目录列表。

通过普通路由提供访问入口：

```ts
// routes/live.ts
import { defineHandler } from 'void';
import { live } from '../src/live';

export const GET = defineHandler((c) => live.connect(c));
export const POST = defineHandler((c) => live.control(c));
```

`GET` 建立 SSE 连接。`POST` 接收针对该连接的订阅和取消订阅操作。

## 从浏览器订阅 {#subscribe-from-the-browser}

使用 `void/live/client` 提供的浏览器辅助函数：

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

订阅 ID 的作用范围是单条连接。重复使用同一个 ID 会替换对应的订阅。重连后，辅助函数会恢复仍然有效的订阅，并将各订阅最新的 `eventId` 作为 `lastEventId` 发送。

## 发布事件 {#publish}

任何能够访问 Void 运行时 env 的服务端代码都可以发布事件：

```ts
import { live } from '../src/live';

await live.publish(
  'post:12',
  { title: 'Updated title' },
  { type: 'updated', eventId: 'post-12-v8' },
);
```

主题名称和 JSON 数据由你自行定义。Void 会在事件封装中包含 `type` 和 `eventId`，但不会解释或存储它们，也不会使用原生 SSE 的 `id` 字段。

如果代码不在活动的请求或运行时上下文中，请显式传入 env：

```ts
await live.withEnv(env).publish('post:12', { title: 'Updated title' });
```

## 授权 {#authorization}

只有连接的所有者才能修改该连接的订阅。上面的示例允许匿名连接；需要身份认证的事件流默认使用当前 Void 用户作为所有者。

所有者决定谁能修改连接的订阅，并不决定该连接可以读取哪些主题。

对于需要身份认证的事件流，请向 `connect()` 和 `control()` 传入相同的所有者标识：

```ts
return live.connect(c, { owner: `user:${session.userId}` });
return live.control(c, { owner: `user:${session.userId}` });
```

如果所有路由都应使用相同的方式确定连接所有者，可以通过 `identifyConnection` 统一定义：

```ts
export const live = defineLiveStream({
  id: 'app',
  async identifyConnection(ctx) {
    const session = await getSession(ctx.request);
    return session ? `user:${session.userId}` : null;
  },
});
```

当 `identifyConnection` 返回 `null` 或 `undefined` 时，Void 会尝试使用当前已认证用户。如果用户的 `id` 是字符串，则使用 `user:${user.id}`。如果两种方式都无法确定所有者，且未设置 `allowAnonymousControl`，请求会被拒绝并返回 `403`。

如果未设置 `onSubscribe`，任何通过所有者检查的连接都可以订阅任意主题，并接收发布到该主题的所有内容。这包括所有已登录用户，以及设置 `allowAnonymousControl` 后的所有访客。主题名称很容易被猜到。请使用 `onSubscribe` 决定谁可以读取各个主题：返回一个 `Response` 表示拒绝订阅，不返回值则表示允许订阅。

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

## 限制 {#limits}

`void/live` 面向中小规模的事件分发。默认情况下，一个事件流允许：

- 每条浏览器连接最多有 `256` 个活动订阅
- 每个主题最多有 `256` 个活动订阅
- 每次控制请求最多包含 `100` 次订阅或取消订阅操作
- 每条连接最多排队等待发送 `100` 个事件
- 每个事件封装编码后最大为 `64 KiB`

每个活动主题最多支持 256 个订阅，与应用使用了多少个主题名称无关。例如，使用 `post:${postId}` 可以让每篇文章拥有独立的订阅数量限制。同一用户打开两个标签页，可能会占用两个订阅名额。

你可以为每个事件流设置更低的限制：

```ts
export const live = defineLiveStream({
  id: 'app',
  limits: {
    maxSubscriptionsPerTopic: 64,
  },
});
```

`maxSubscriptionsPerTopic` 不能超过 `256`。对于更大规模的广播，请将订阅者分散到不同的应用主题中，或使用专门的实时通信系统。

## 投递语义 {#delivery-semantics}

同一主题内的事件按顺序投递，且最多投递一次。部署、回滚、重启和重连都可能丢失实时状态，因此客户端可能漏收事件。直接使用 HTTP 的客户端在重连后必须重新订阅。

如果需要回放，请在应用中存储事件，并使用 `eventId` 和 `lastEventId` 恢复。Void 不会存储事件，也不会管理客户端状态。

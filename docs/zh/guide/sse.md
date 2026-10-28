---
outline: deep
---

# 服务端发送事件 {#server-sent-events}

使用 `void/sse` 可以从路由处理函数向浏览器推送事件流。Void 会格式化消息、发送保活消息，并在请求结束时关闭流。

SSE 适合推送单次请求产生的 AI token、进度更新或日志。如果需要从其他请求向已连接的客户端发布事件，请参阅[实时事件流](/zh/guide/live)。如果客户端需要回放事件，请自行存储这些事件。

## 服务端事件流 {#server-streams}

在路由处理函数中返回 `eventStream()`：

```ts
// routes/api/events.ts
import { defineHandler } from 'void';
import { eventStream } from 'void/sse';

export const GET = defineHandler((c) => {
  return eventStream(
    async (stream) => {
      await stream.comment('connected');
      await stream.send({
        event: 'ready',
        data: { now: Date.now() },
      });

      const timer = setInterval(() => {
        void stream.send({ event: 'tick', data: { now: Date.now() } }).catch(() => stream.close());
      }, 1000);

      await stream.closed;
      clearInterval(timer);
    },
    {
      signal: c.req.raw.signal,
    },
  );
});
```

`eventStream()` 会立即返回一个 `Response`，默认包含以下响应头：

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

`start` 回调返回后，流就会关闭。需要保持连接的流应在返回前等待 `stream.closed`、生产者的 Promise，或应用的取消信号。

## 发送事件 {#sending-events}

使用 `send()` 发送 SSE 消息，使用 `comment()` 发送注释：

```ts
await stream.send({
  id: 'evt_1',
  event: 'post.update',
  retry: 1000,
  data: { id: 'post_123', likes: 10 },
});

await stream.comment('still connected');
```

`data` 接受字符串或可以序列化为 JSON 的值。SSE 仅支持文本。

向已关闭的流写入数据会抛出 `SseStreamClosedError`。

如果数据已经序列化，可以使用 `formatSseText()` 将其格式化为 SSE 消息：

```ts
import { formatSseText } from 'void/sse';

const frame = formatSseText({
  event: 'post.update',
  data: JSON.stringify({ id: 'post_123', likes: 10 }),
});
```

## 保活消息 {#keepalives}

默认每 15 秒发送一次保活消息：

```ts
return eventStream(start);
```

你可以禁用保活消息，也可以自定义发送间隔和注释文本：

```ts
return eventStream(start, { keepAlive: false });

return eventStream(start, {
  keepAlive: { intervalMs: 5000, comment: 'ping' },
});
```

## 最近一次事件的 ID {#last-event-id}

浏览器收到带有 `id` 字段的事件后，会在重连时发送 `Last-Event-ID`。使用 `getLastEventId()` 获取该值，即可从你自己的存储中恢复事件流：

```ts
import { getLastEventId } from 'void/sse';

export const GET = defineHandler((c) => {
  const lastId = getLastEventId(c.req.raw);
  return eventStream(async (stream) => {
    await stream.send({ id: nextId(lastId), data: await loadNextItem(lastId) });
  });
});
```

## 客户端 {#client}

从仅供浏览器使用的 `void/sse/client` 子路径导入 `connectEventStream()`：

```ts
import { connectEventStream } from 'void/sse/client';

const stream = connectEventStream<{
  ready: { now: number };
  tick: { now: number };
}>('/api/events', {
  withCredentials: true,
});

const offReady = stream.on('ready', (event) => {
  console.log(event.data.now);
});

stream.on('tick', (event) => {
  console.log(event.data.now);
});

offReady();
stream.close();
```

客户端封装了原生 `EventSource`，支持 Cookie 凭据和类型化事件处理函数，但不支持请求体或任意自定义请求头。需要自定义请求头时，可以使用 Cookie 认证、签名 URL，或基于 fetch 的流式路由。

默认按 JSON 解析数据。对于非 JSON 数据，可以设置 `parse: 'text'`，或传入自定义解析器：

```ts
const logs = connectEventStream('/api/logs', { parse: 'text' });

logs.on('line', (event) => {
  console.log(event.data);
});
```

## 身份认证 {#auth}

SSE 路由就是普通的路由处理函数，因此可以使用与 JSON 路由相同的身份认证检查：

```ts
import { requireAuth } from 'void/auth';

export const GET = defineHandler(async (c) => {
  const user = await requireAuth(c);

  return eventStream(async (stream) => {
    await stream.send({ event: 'ready', data: { userId: user.id } });
    await stream.closed;
  });
});
```

需要共享主题和订阅时，请使用[实时事件流](/zh/guide/live)。需要双向通信时，请使用 [WebSockets](/zh/guide/websockets)。

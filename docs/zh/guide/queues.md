---
outline: deep
---

# 队列 {#queues}

使用队列可以异步处理任务，例如发送邮件或处理上传。在 `queues/` 中定义消费者，再从应用中向它发送带类型的消息。

## 定义队列 {#defining-queues}

在 `queues/` 中创建消费者。支持 TypeScript 和 JavaScript 文件（`.ts`、`.mts`、`.js`、`.mjs`）。文件路径决定队列名称：`queues/emails.ts` 创建 `emails`，`queues/order/notifications.ts` 创建 `order-notifications`。每个队列的名称必须唯一。

生成的名称必须符合 Cloudflare 的队列命名规则：长度为 1–63 个字符，只能包含字母、数字和 `-`，且必须以字母或数字开头和结尾。使用 `void deploy --platform cloudflare` 时，Cloudflare 队列名称还会包含 Worker 名称，因此此长度限制适用于完整名称；请参阅 [Cloudflare 队列名称](#cloudflare-queue-names)。

默认导出一个使用 [`defineQueue<T>`](/zh/reference/api/handlers#definequeue-t-handler) 包装的处理函数。`T` 定义了消息体的类型，消费者和 `send()` 调用都使用该类型：

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

以 `_` 开头的文件或目录会被忽略。

## 发送消息 {#sending-messages}

从 `void/queues` 导入类型化的 `queues` 代理来发送消息。每个队列都可以通过与其名称相同的属性访问，消费者的 `defineQueue<T>` 泛型会为其提供完整的类型安全。

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

## 逐条确认消息 {#per-message-acknowledgment}

批次中的每条消息都有 `ack()` 和 `retry()` 方法，与 [Cloudflare Queues API](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) 一致：

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

- `msg.ack()`：确认消息并将其从队列中移除
- `msg.retry(options?)`：重试消息，可以通过 `{ delaySeconds }` 设置延迟
- `batch.ackAll()`：确认批次中的所有消息
- `batch.retryAll(options?)`：重试批次中的所有消息

对于每条消息，只有第一次调用生效。在 `retry()` 之后调用 `ack()`，或反过来调用，都不会产生影响。如果未明确指定如何处理某条消息，处理函数成功时会确认该消息，抛出异常时则会重试。

每条消息的 `timestamp` 字段都是一个 `Date` 对象。

## 消费者选项 {#consumer-options}

导出具名常量，配置 Cloudflare 向消费者投递批次的方式：

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

- `maxBatchSize`：每个批次的最大消息数（默认为 `10`）
- `maxBatchTimeout`：批次未满时，投递前最多等待的秒数（默认为 `5`）
- `maxRetries`：投递失败后的最大重试次数（默认为 `3`）
- `retryDelay`：两次重试之间等待的秒数（默认为 `0`）

Void 管理的队列不会配置死信队列。没有死信队列时，Cloudflare 会永久删除达到重试上限的消息；请参阅 [Cloudflare 死信队列指南](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)。

Void 会在部署时创建队列，并连接生产者和消费者。

### Cloudflare 队列名称 {#cloudflare-queue-names}

队列名称在同一个 Cloudflare 账号内必须唯一。因此，`void deploy --platform cloudflare` 会将 Worker 名称加入各个队列名称：对于名为 `app-staging` 的 Worker，`queues/jobs.ts` 使用的 Cloudflare 队列名为 `app-staging-jobs`（Worker 名称中的 `_` 会变为 `-`）。同一个账号下的两个 Worker，例如 `app-staging` 和 `app-production`，会使用各自独立的队列。代码中仍使用 `queues/` 下的名称（`queues.jobs.send()`），`vp dev` 也使用该名称。

出现以下情况时，部署会在创建任何资源前停止：

- 新队列的完整名称超过 63 个字符。请缩短 Worker 名称或文件名。
- 一个队列的完整名称与 `queues/` 中另一个文件对应的名称相同，例如 Worker `app` 中的 `queues/jobs.ts` 和 `queues/app-jobs.ts`。请重命名其中一个文件。
- 本次部署准备使用的 Cloudflare 队列已经由另一个 Worker 消费。一个 Cloudflare 队列只能有一个消费者。

如果 Worker 已经在消费某个队列，该队列会保留原名。因此，在引入以 Worker 名称命名的队列之前部署的应用，会继续使用原有队列（例如 `jobs`），其中的消息也会保留。保留名称时，部署过程会输出提示。要切换到包含 Worker 名称的新队列，请先在 Cloudflare 控制台中从旧队列移除该 Worker 的消费者，再重新部署。在此次部署完成前到达旧队列的消息会留在旧队列中，因此请在应用不发送消息时执行此操作，并在删除旧队列前确认其中已没有消息。

## 本地开发 {#local-development}

在原生 Void 应用中，通过队列绑定发送消息会自动在 Miniflare 中调用消费者。本地投递与生产环境使用相同的处理函数。

你也可以向 Void 提供的开发端点发送 POST 请求，手动投递一个批次：

```
POST /__void/queue
Content-Type: application/json
{ "queue": "<queue-name>", "messages": [{ "id": "1", "timestamp": <unix_ms>, "body": <any>, "attempts": 1 }] }
```

此端点需要本地开发触发令牌。开发服务器启动时，Void 会输出一条包含当前令牌、可以直接复制使用的 curl 命令。

```bash
curl -X POST http://localhost:5173/__void/queue \
  -H "Content-Type: application/json" \
  -H "x-void-dev-trigger: <printed-token>" \
  -d '{"queue":"my-queue","messages":[{"id":"1","timestamp":'"$(date +%s000)"',"body":{"hello":"world"},"attempts":1}]}'
```

在受支持的元框架中，请使用 `/__void/queue` 手动测试消费者。消费者会在框架适配器的开发运行时中执行，并使用该适配器的绑定。在此模式下，向队列绑定发送消息不会自动调用消费者。

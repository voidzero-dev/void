---
outline: deep
---

# 资源客户端 {#resource-clients}

## KV {#kv}

从 `"void/kv"` 导入。

### `kv` {#kv-1}

推断出的 `KV` 绑定对应的类型化客户端，支持 JSON 数据。

```ts
import { kv } from 'void/kv';

await kv.put('settings', { theme: 'dark' });
const settings = await kv.get<{ theme: string }>('settings');
```

**主要导出：** `kv`、`createKV(namespace)`、`KVClient`、`KVMap`、`PutOptions`、`ListOptions`。

`kv.map(prefix)` 创建类型化的命名空间视图，每个键都会加上 `prefix:` 前缀后存储。

## 存储 {#storage}

从 `"void/storage"` 导入。

### `storage` {#storage-1}

推断出的 `STORAGE` 绑定对应的默认 [R2 存储桶](https://developers.cloudflare.com/r2/)代理。

```ts
import { storage } from 'void/storage';

await storage.put('avatars/alice.png', file);
const object = await storage.get('avatars/alice.png');
```

**主要导出：** `storage`、`createStorage(bucket)`。

## AI {#ai}

从 `"void/ai"` 导入。

### `ai` {#ai-1}

类型化的 AI 客户端，支持 Cloudflare AI 模型，以及通过 AI Gateway 发起提供方原生格式的请求。

```ts
import { ai } from 'void/ai';

const result = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
  messages: [{ role: 'user', content: 'Summarize this release note.' }],
});

const response = await ai.provider('openai').fetch('/chat/completions', {
  body: {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Summarize this release note.' }],
  },
});
```

**主要导出：** `ai`、`VoidAi` 和提供方请求类型。提供方配置和流式响应示例，见 [AI](/zh/guide/ai)。

AI 方法返回 Promise。触及用量限制时，Promise 会以 `void/limits` 中的 `UsageLimit` 错误拒绝。Void 路由和 Pages Action 会为未捕获的用量限制返回结构化 HTTP 429 响应。如需自行通过 `instanceof UsageLimit` 处理，见[用量限制](/zh/guide/ai#usage-limits)。

### 提供方密钥 {#provider-keys}

`ai.provider()` 使用的默认密钥名称。通过 `apiKeyEnv` 可以选择其他名称。

| 提供方前缀 | 环境变量 |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google-ai-studio` | `GOOGLE_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `grok` | `GROK_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `perplexity` | `PERPLEXITY_API_KEY` |
| `cohere` | `COHERE_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `huggingface` | `HUGGINGFACE_API_KEY` |
| `replicate` | `REPLICATE_API_KEY` |
| `baseten` | `BASETEN_API_KEY` |
| `cartesia` | `CARTESIA_API_KEY` |
| `deepgram` | `DEEPGRAM_API_KEY` |
| `elevenlabs` | `ELEVENLABS_API_KEY` |
| `fal` | `FAL_API_KEY` |
| `ideogram` | `IDEOGRAM_API_KEY` |
| `parallel` | `PARALLEL_API_KEY` |

## ISR {#isr}

从 `"void/isr"` 导入。

### `revalidate(options)` {#revalidate-options}

按需使 ISR 页面缓存失效。本地开发时没有边缘 ISR 缓存，因此调用不会执行任何操作。

```ts
import { revalidate } from 'void/isr';

await revalidate({ paths: ['/', '/blog/hello'] });
await revalidate({ all: true });
```

**签名：**

```ts
function revalidate(options: { paths?: string[]; all?: boolean }): Promise<void>;
```

## 日志 {#logging}

从 `"void/log"` 导入。

### `logger` {#logger}

结构化日志记录器，每次调用输出一行 JSON，便于按消息和字段筛选已部署应用的日志。

```ts
import { logger } from 'void/log';

logger.info('checkout completed', { orderId, userId });
logger.error('webhook failed', { provider: 'stripe', attempt: 3 });
```

**方法：** `logger.error(message, fields?)`、`logger.warn(message, fields?)`、`logger.info(message, fields?)`。

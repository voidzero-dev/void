---
outline: deep
---

# AI {#ai}

在服务端代码中，使用 `void/ai` 导出的 `ai` 调用 Workers AI 模型和提供商 API。对提供商的请求会经过 Cloudflare 的 [AI Gateway](https://developers.cloudflare.com/ai-gateway/)。

## 本地开发 {#local-development}

对于直接部署到 Cloudflare 的项目，先连接账号，再启动开发服务器：

```sh
void connect --platform cloudflare
npm run dev
```

应用导入 `void/ai` 后，Void 会在开发和预览时启用远程 Workers AI 绑定。请求会使用你的 Cloudflare 账号及其额度；Workers AI 没有本地模拟器。开发和预览使用与 `void connect` 相同的 Cloudflare 登录凭据，可通过 `void cloudflare login` 登录。`CLOUDFLARE_API_TOKEN` 的优先级更高，自动化环境应使用此令牌。

如果 Cloudflare 身份验证错误导致开发服务器停止，请先通过 `void cloudflare status` 确认部署账号，再以有权访问该账号的用户在终端运行 `void cloudflare login`，或设置 `CLOUDFLARE_API_TOKEN`。`wrangler login` 不会影响开发环境的身份验证。

对于团队平台，使用 `void connect <platform-url>` 连接平台并关联项目。开发请求使用平台的账号，并受平台用量限制。

## 基本用法 {#basic-usage}

调用 `ai.run()` 时传入模型名称和输入数据。模型名称和输入类型均由 `@cloudflare/workers-types` 提供完整的类型支持。

```ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  const result = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
  });
  return c.json(result);
});
```

AI 方法返回 Promise。你可以等待调用结果，也可以在处理函数中直接返回 Promise。额度相关的错误请参阅[用量限制](#usage-limits)。

你可以使用 Cloudflare AI 绑定支持的任意模型，包括 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 等 Workers AI 模型，以及 `google/gemini-2.5-flash`、`openai/gpt-4.1-mini` 等 Cloudflare Gateway 模型。输入对象必须符合所选 Cloudflare 模型的 schema。生成图片等模型返回的二进制数据会封装为 `Blob`，由 `ai.run()` 返回。

## 流式响应 {#streaming}

使用 `ai.stream()` 获取带有 SSE 响应头的流式响应，并在路由处理器中直接返回：

```ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  return ai.stream('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
  });
});
```

如果生成过程在响应开始后中断，流式响应会以 `void:error` SSE 事件结束；如果达到用量上限，则以 `void:limit` 事件结束。`void/client` 导出的 `fetchStream()` 会在流开始前或流传输期间遇到用量限制时抛出 `UsageLimit`，遇到其他导致流终止的错误时抛出 `StreamError`。在 UI 中捕获错误，结束生成状态、保留已接收的部分输出，并提供重试操作。这同样适用于提供商的流式响应，以及设置了 `stream: true` 的 `ai.run()` 调用。

## 列出模型 {#listing-models}

使用 `ai.models()` 列出可用模型：

```ts
const models = await ai.models();

// Filter by task
const textModels = await ai.models({ task: 'Text Generation' });
```

## 转换为 Markdown {#markdown-conversion}

使用 `ai.toMarkdown()` 将文档转换为 Markdown：

```ts
const result = await ai.toMarkdown([{ name: 'document.pdf', blob: pdfBytes }]);
```

## 用量限制 {#usage-limits}

Workers AI 的用量以 [neurons（神经元）](https://developers.cloudflare.com/workers-ai/platform/pricing/)计量。直接部署时，用量计入你的 Cloudflare 账号。提供商原生请求还会使用你自己的提供商凭据，并按该提供商的计费规则收费。

团队平台使用平台自己的 Cloudflare 账号，也可能对每位用户设置用量上限。请向管理员了解可用额度。

达到用量上限时，操作的 Promise 会以 `UsageLimit` 错误拒绝，该错误从 `void/limits` 导入。错误包含 `resource`、`reason`，以及可选的 `retryAt` 时间戳。在 Void 路由处理函数和页面 Action 中，未捕获的用量限制错误会生成包含重试信息的结构化 HTTP 429 响应。在队列、定时任务和其他服务端代码中，它仍表现为被拒绝的 Promise。

你可以自行决定是否处理用量限制。如果需要回退行为或符合应用场景的提示信息，可使用 `instanceof UsageLimit` 判断：

```ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';
import { UsageLimit } from 'void/limits';

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();
  try {
    const result = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof UsageLimit) {
      return error.response({ message: 'Try again shortly. Your prompt has been kept.' });
    }
    throw error;
  }
});
```

`error.response()` 会创建结构化的 HTTP 429 响应，也可通过可选的 `message` 自定义提示信息。如果发生其他错误，Promise 仍会被拒绝。使用 `fetchStream()` 时，客户端也可以通过相同的 `instanceof UsageLimit` 判断取得提示信息和重试信息。

## Cloudflare Gateway 模型 {#cloudflare-gateway-models}

`ai.run()` 沿用 Cloudflare `env.AI.run()` 的模型命名方式和输入 schema。第三方模型使用 Cloudflare 模型 ID，以及由 Cloudflare 管理的凭据。

```ts
const result = await ai.run('google/gemini-2.5-flash', {
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Explain Durable Objects in one paragraph.' }],
    },
  ],
});
```

将 AI Gateway 选项作为第三个参数传入：`ai.run(model, inputs, { gateway: { skipCache: true } })`。在团队平台上，网关由平台选择，其元数据和日志设置也由平台管理；`skipCache`、`cacheTtl` 等选项仍然生效。

直接部署时，如需发起提供商原生请求，请配置 [`ai.gateway`](/integrations/cloudflare#ai-self-host)。

## 提供商原生请求 {#provider-native-requests}

使用 `ai.provider(provider).fetch(path, init)` 调用提供商原生 API，并使用你自己的提供商密钥。请求会经过已配置的 Cloudflare AI Gateway，同时保留提供商原生的 HTTP 请求与响应格式。在团队平台上，请求还会经过该平台实例的代理。AI Gateway 的缓存、超时和重试请求头，例如 `cf-aig-cache-ttl`、`cf-aig-max-attempts`，在平台代理中仍然生效；日志、元数据和费用请求头则会被平台忽略。

### OpenAI {#openai}

```ts
import { defineHandler } from 'void';
import { ai } from 'void/ai';

export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  return ai.provider('openai').fetch('/chat/completions', {
    body: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
    },
  });
});
```

### Google AI Studio {#google-ai-studio}

```ts
const response = await ai
  .provider('google-ai-studio')
  .fetch('/v1/models/gemini-2.5-flash:generateContent', {
    body: {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'What is Cloudflare?' }],
        },
      ],
    },
  });
```

### 自定义提供商 {#custom-providers}

如果提供商不在 Void 的默认密钥映射中，请指定 Secret 名称和承载 API 密钥的请求头：

```ts
const response = await ai
  .provider('custom-provider', {
    apiKeyEnv: 'CUSTOM_PROVIDER_API_KEY',
    apiKeyHeader: 'x-api-key',
    apiKeyPrefix: '',
  })
  .fetch('/v1/respond', {
    body: { prompt: 'Hello' },
  });
```

### 图片生成 {#image-generation}

对于 Cloudflare 原生图片模型，使用 `ai.run()` 或 `ai.image()`：

```ts
export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();
  return ai.image('@cf/black-forest-labs/flux-1-schnell', { prompt });
});
```

对于提供商原生图片 API，使用 `ai.provider().fetch()`，并遵循[提供商的请求 schema](https://developers.openai.com/api/reference/resources/images/methods/generate)：

```ts
export const POST = defineHandler(async (c) => {
  const { prompt } = await c.req.json();

  return ai.provider('openai').fetch('/images/generations', {
    body: {
      model: 'gpt-image-2.5-sunburst',
      prompt,
      size: '1024x1024',
    },
  });
});
```

对于使用 multipart 格式的提供商 API，传入 `FormData`：

```ts
export const POST = defineHandler(async (c) => {
  const body = await c.req.parseBody();
  const form = new FormData();
  form.set('model', 'gpt-image-2.5-sunburst');
  form.set('prompt', String(body.prompt));
  form.set('image', body.image as Blob, 'source.png');

  return ai.provider('openai').fetch('/images/edits', { body: form });
});
```

### 提供商密钥约定 {#provider-key-convention}

提供商原生请求使用项目 Secret，例如 OpenAI 的 `OPENAI_API_KEY`，或 Google AI Studio 的 `GOOGLE_API_KEY`。

支持的提供商及其 Secret 名称见[提供商密钥参考](/zh/reference/api/resources#provider-keys)。

兼容 OpenAI 的提供商使用 `Authorization: Bearer <key>`，Google AI Studio 使用 `x-goog-api-key`。对于自定义提供商，可通过 `apiKeyHeader` 和 `apiKeyPrefix` 指定。

在生产环境中，将 API 密钥添加为项目 Secret：

```bash
void secret put OPENAI_API_KEY=sk-...
```

在本地开发时，将 API 密钥添加到项目根目录的 `.env` 文件：

```dotenv
OPENAI_API_KEY=sk-...
```

### 提供商原生 API 的流式响应 {#streaming-with-provider-native-apis}

直接返回提供商的响应即可。例如，在上面的 OpenAI 请求体中添加 `stream: true`。

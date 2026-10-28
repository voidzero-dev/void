---
outline: deep
---

# Resource Clients

## KV {#kv}

Imported from `"void/kv"`.

### `kv` {#kv-1}

Typed JSON-aware client for the inferred `KV` binding.

```ts
import { kv } from 'void/kv';

await kv.put('settings', { theme: 'dark' });
const settings = await kv.get<{ theme: string }>('settings');
```

**Key exports:** `kv`, `createKV(namespace)`, `KVClient`, `KVMap`, `PutOptions`, `ListOptions`.

`kv.map(prefix)` creates a typed namespaced view where every key is stored under `prefix:`.

## Storage {#storage}

Imported from `"void/storage"`.

### `storage` {#storage-1}

Default [R2 bucket](https://developers.cloudflare.com/r2/) proxy for the inferred `STORAGE` binding.

```ts
import { storage } from 'void/storage';

await storage.put('avatars/alice.png', file);
const object = await storage.get('avatars/alice.png');
```

**Key exports:** `storage`, `createStorage(bucket)`.

## AI {#ai}

Imported from `"void/ai"`.

### `ai` {#ai-1}

Typed AI client for Cloudflare AI models and provider-native AI Gateway requests.

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

**Key exports:** `ai`, `VoidAi`, provider request types. See [AI](../../guide/ai.md) for provider setup and streaming examples.

AI methods return promises and reject usage limits with `UsageLimit` from `void/limits`. Void routes and Pages actions return a structured HTTP 429 for uncaught limits. See [usage limits](../../guide/ai.md#usage-limits) for optional `instanceof UsageLimit` handling.

### Provider keys

Default secret names for `ai.provider()`. Use `apiKeyEnv` to choose another name.

| Provider prefix    | Env var               |
| ------------------ | --------------------- |
| `openai`           | `OPENAI_API_KEY`      |
| `anthropic`        | `ANTHROPIC_API_KEY`   |
| `google-ai-studio` | `GOOGLE_API_KEY`      |
| `deepseek`         | `DEEPSEEK_API_KEY`    |
| `groq`             | `GROQ_API_KEY`        |
| `mistral`          | `MISTRAL_API_KEY`     |
| `grok`             | `GROK_API_KEY`        |
| `openrouter`       | `OPENROUTER_API_KEY`  |
| `perplexity`       | `PERPLEXITY_API_KEY`  |
| `cohere`           | `COHERE_API_KEY`      |
| `cerebras`         | `CEREBRAS_API_KEY`    |
| `huggingface`      | `HUGGINGFACE_API_KEY` |
| `replicate`        | `REPLICATE_API_KEY`   |
| `baseten`          | `BASETEN_API_KEY`     |
| `cartesia`         | `CARTESIA_API_KEY`    |
| `deepgram`         | `DEEPGRAM_API_KEY`    |
| `elevenlabs`       | `ELEVENLABS_API_KEY`  |
| `fal`              | `FAL_API_KEY`         |
| `ideogram`         | `IDEOGRAM_API_KEY`    |
| `parallel`         | `PARALLEL_API_KEY`    |

## ISR {#isr}

Imported from `"void/isr"`.

### `revalidate(options)` {#revalidate-options}

Revalidate ISR-cached pages on demand. In local development this is a no-op because there is no edge ISR cache.

```ts
import { revalidate } from 'void/isr';

await revalidate({ paths: ['/', '/blog/hello'] });
await revalidate({ all: true });
```

**Signature:**

```ts
function revalidate(options: { paths?: string[]; all?: boolean }): Promise<void>;
```

## Logging {#logging}

Imported from `"void/log"`.

### `logger` {#logger}

Structured logger that emits one JSON line per call so deployed logs can be filtered by message and fields.

```ts
import { logger } from 'void/log';

logger.info('checkout completed', { orderId, userId });
logger.error('webhook failed', { provider: 'stripe', attempt: 3 });
```

**Methods:** `logger.error(message, fields?)`, `logger.warn(message, fields?)`, `logger.info(message, fields?)`.

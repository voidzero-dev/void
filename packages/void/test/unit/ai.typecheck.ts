import { expectTypeOf } from 'vite-plus/test';
import type { ai } from '../../src/runtime/ai/index.ts';

declare const client: typeof ai;
const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const result = client.run(model, { messages: [{ role: 'user', content: 'Hello' }] });
expectTypeOf(result).toEqualTypeOf<Promise<AiModels[typeof model]['postProcessedOutputs']>>();
expectTypeOf(client.stream(model, {})).toEqualTypeOf<Promise<Response>>();
expectTypeOf(client.image(model, {})).toEqualTypeOf<Promise<Response>>();
expectTypeOf(client.provider('openai').fetch('/chat/completions')).toEqualTypeOf<
  Promise<Response>
>();

client.provider('openai').fetch('/chat/completions', {
  signal: AbortSignal.timeout(30_000),
  body: {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
  },
});
client.provider('custom', { apiKeyEnv: 'CUSTOM_AI_KEY' }).fetch('/v1/respond', {
  signal: null,
  method: 'POST',
  headers: { 'x-test': '1' },
  body: new Uint8Array([1, 2]),
});

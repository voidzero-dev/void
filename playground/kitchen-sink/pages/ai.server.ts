import { defineHandler } from 'void';
import type { InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return {
    models: [
      {
        value: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        label: 'Llama 3.3 70B (Workers AI)',
      },
      { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)' },
      { value: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini (OpenAI)' },
      {
        value: 'anthropic/claude-sonnet-4-20250514',
        label: 'Claude Sonnet 4 (Anthropic)',
      },
    ],
  };
});

// Provider-native AI Gateway helpers.

export type AiProviderName =
  | 'openai'
  | 'anthropic'
  | 'google-ai-studio'
  | 'groq'
  | 'mistral'
  | 'grok'
  | 'deepseek'
  | 'openrouter'
  | 'perplexity'
  | 'cohere'
  | 'cerebras'
  | 'huggingface'
  | 'replicate'
  | 'baseten'
  | 'cartesia'
  | 'deepgram'
  | 'elevenlabs'
  | 'fal'
  | 'ideogram'
  | 'parallel';

export type AiProvider = AiProviderName | (string & {});

/**
 * @deprecated No Void API accepts this type. To send a file with `ai.provider().fetch()`,
 * put it in `FormData`. Removed in the next major version.
 */
export type ImageFileInput =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | {
      data: string;
      name?: string;
      type?: string;
    };

export type AiProviderOptions = {
  apiKeyEnv?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
};

export type AiProviderFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

/** Maps provider prefix to expected env var name for the API key */
export const PROVIDER_KEY_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'google-ai-studio': 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  grok: 'GROK_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  cohere: 'COHERE_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  replicate: 'REPLICATE_API_KEY',
  baseten: 'BASETEN_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  fal: 'FAL_API_KEY',
  ideogram: 'IDEOGRAM_API_KEY',
  parallel: 'PARALLEL_API_KEY',
};

<script setup lang="ts">
import { ref } from 'vue';
import type { Props } from './ai.server.ts';

const props = defineProps<Props>();

const selectedModel = ref(props.models[0].value);
const prompt = ref('');
const response = ref('');
const loading = ref(false);
const error = ref('');

function textFromAiResult(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }

  const result = value as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };

  if (typeof result.response === 'string') {
    return result.response;
  }

  const choice = result.choices?.[0];
  if (typeof choice?.delta?.content === 'string') {
    return choice.delta.content;
  }
  if (typeof choice?.message?.content === 'string') {
    return choice.message.content;
  }

  const parts = result.candidates?.[0]?.content?.parts;
  if (parts) {
    return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
  }

  return '';
}

async function submit() {
  if (!prompt.value.trim()) {
    return;
  }
  loading.value = true;
  response.value = '';
  error.value = '';

  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.value, model: selectedModel.value }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        message?: string;
        error?: string;
      } | null;
      error.value = body?.message ?? body?.error ?? `${res.status} ${res.statusText}`;
      return;
    }

    if (res.headers.get('content-type')?.includes('application/json')) {
      const parsed = await res.json();
      response.value = textFromAiResult(parsed) || JSON.stringify(parsed, null, 2);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
          continue;
        }
        if (!line.trim()) {
          event = '';
          continue;
        }
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (event === 'void:error' || event === 'void:limit') {
              error.value =
                typeof parsed.message === 'string' ? parsed.message : 'Generation was interrupted.';
              await reader.cancel();
              return;
            }
            response.value += textFromAiResult(parsed);
          } catch {
            // skip unparseable chunks
          }
        }
      }
    }
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div>
    <h1>AI</h1>
    <p>AI inference via <code>void/ai</code>.</p>

    <h2>Model</h2>
    <select v-model="selectedModel" style="font-family: monospace; padding: 4px">
      <option v-for="m in models" :key="m.value" :value="m.value">
        {{ m.label }}
      </option>
    </select>

    <h2>Prompt</h2>
    <form @submit.prevent="submit">
      <div>
        <textarea
          v-model="prompt"
          placeholder="Ask something..."
          rows="3"
          style="width: 100%; font-family: monospace"
        ></textarea>
      </div>
      <button type="submit" :disabled="loading" style="margin-top: 5px">
        {{ loading ? 'Generating...' : 'Send' }}
      </button>
    </form>

    <div v-if="error" style="color: red; margin-top: 10px"><strong>Error:</strong> {{ error }}</div>

    <h2>Response</h2>
    <pre style="white-space: pre-wrap; background: #f5f5f5; padding: 10px; min-height: 60px">{{
      response || '(waiting for prompt...)'
    }}</pre>
  </div>
</template>

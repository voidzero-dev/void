<script setup lang="ts">
import { ref } from 'vue';
import type { Props } from './sandbox.server.ts';

const props = defineProps<Props>();

const sampleRequests = props.sampleRequests;
const code = ref(props.defaultCode);
const loading = ref(false);
const error = ref('');
const result = ref<unknown>(null);
const stdout = ref('');
const stderr = ref('');
const exitCode = ref<number | null>(null);
const duration = ref<number | null>(null);

async function runCode() {
  loading.value = true;
  error.value = '';
  result.value = null;
  stdout.value = '';
  stderr.value = '';
  exitCode.value = null;
  duration.value = null;

  try {
    const res = await fetch('/api/sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.value }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      message?: string;
      output?: unknown;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      duration?: number;
    };

    if (!res.ok || !body.ok) {
      error.value = body.message ?? body.error ?? body.stderr ?? `${res.status} ${res.statusText}`;
    }

    result.value = body.output ?? null;
    stdout.value = body.stdout ?? '';
    stderr.value = body.stderr ?? '';
    exitCode.value = body.exitCode ?? null;
    duration.value = body.duration ?? null;
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div>
    <h1>Sandbox</h1>
    <p>
      Run user-authored JavaScript in an isolated Cloudflare Sandbox. The Worker writes files into
      <code>/workspace</code>, executes <code>node run.mjs</code>, and reads the result back.
    </p>

    <h2>Sample Edge Requests</h2>
    <pre style="white-space: pre-wrap; background: #f5f5f5; padding: 10px">{{
      JSON.stringify(sampleRequests, null, 2)
    }}</pre>

    <h2>Analyzer Code</h2>
    <form @submit.prevent="runCode">
      <textarea
        v-model="code"
        rows="22"
        spellcheck="false"
        style="width: 100%; font-family: monospace"
      ></textarea>
      <button type="submit" :disabled="loading" style="margin-top: 5px">
        {{ loading ? 'Running in sandbox...' : 'Run in Sandbox' }}
      </button>
    </form>

    <div v-if="error" style="color: red; margin-top: 10px"><strong>Error:</strong> {{ error }}</div>

    <h2>Result</h2>
    <p v-if="exitCode !== null">Exit <code>{{ exitCode }}</code>, {{ duration }}ms</p>
    <pre style="white-space: pre-wrap; background: #f5f5f5; padding: 10px; min-height: 60px">{{
      result ? JSON.stringify(result, null, 2) : '(run the analyzer)'
    }}</pre>

    <h2>Process Output</h2>
    <pre style="white-space: pre-wrap; background: #f5f5f5; padding: 10px; min-height: 60px">{{
      [stdout, stderr].filter(Boolean).join('\n') || '(no stdout/stderr yet)'
    }}</pre>
  </div>
</template>

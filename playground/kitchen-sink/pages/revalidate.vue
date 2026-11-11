<script setup lang="ts">
import { useForm } from '@void/vue';
import type { Props } from './revalidate.server.ts';

defineProps<Props>();

const form = useForm('/revalidate', {});
</script>
<template>
  <div>
    <h1>Revalidate</h1>
    <p>ISR revalidation via <code>void/isr</code>.</p>

    <h2>Page State</h2>
    <p>Rendered at: <code>{{ renderedAt }}</code></p>
    <p>
      Last revalidation:
      <code v-if="lastRevalidation">{{ lastRevalidation }}</code>
      <em v-else>never</em>
    </p>

    <h2>Trigger Revalidation</h2>
    <p>
      Click the button to revalidate this page. The "rendered at" timestamp should update on next
      load.
    </p>
    <form @submit.prevent="form.post()">
      <button type="submit" :disabled="form.pending">
        {{ form.pending ? 'Revalidating...' : 'Revalidate /revalidate' }}
      </button>
    </form>
    <p v-if="form.error" role="alert" style="color: red">{{ form.error.message }}</p>
  </div>
</template>

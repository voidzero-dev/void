<script setup lang="ts">
import { useForm } from '@void/vue';
import type { Props } from './kv.server.ts';

defineProps<Props>();

const setForm = useForm('/kv', {
  intent: 'set',
  key: '',
  value: '',
});

const deleteForm = useForm('/kv', {
  intent: 'delete',
  key: '',
});

function deleteKey(name: string) {
  deleteForm.data.key = name;
  deleteForm.post();
}
</script>
<template>
  <div>
    <h1>KV</h1>
    <p>Key-Value storage via <code>void/kv</code>.</p>

    <h2>Set Key</h2>
    <form @submit.prevent="setForm.post()">
      <div>
        <label>Key: </label>
        <input v-model="setForm.data.key" placeholder="my-key" required />
      </div>
      <div style="margin-top: 5px">
        <label>Value: </label>
        <input v-model="setForm.data.value" placeholder="my-value" required />
      </div>
      <button type="submit" :disabled="setForm.pending" style="margin-top: 5px">
        {{ setForm.pending ? 'Saving...' : 'Set' }}
      </button>
    </form>

    <h2>Lookup Key</h2>
    <form method="get" action="/kv">
      <input name="lookup" placeholder="Key to look up" required />
      <button type="submit">Get</button>
    </form>
    <div v-if="lookedUp" style="margin-top: 10px">
      <strong>{{ lookedUp.key }}</strong> =
      <span v-if="lookedUp.value !== null"><code>{{ lookedUp.value }}</code></span>
      <span v-else><em>(not found)</em></span>
    </div>

    <h2>Keys ({{ keys.length }})</h2>
    <table v-if="keys.length">
      <thead>
        <tr>
          <th style="text-align: left">Key</th>
          <th style="text-align: left">Expiration</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="k in keys" :key="k.name">
          <td>
            <code>{{ k.name }}</code>
          </td>
          <td>{{ k.expiration ? new Date(k.expiration * 1000).toISOString() : '\u2014' }}</td>
          <td>
            <button @click="deleteKey(k.name)" :disabled="deleteForm.pending">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else><em>No keys found.</em></p>
  </div>
</template>

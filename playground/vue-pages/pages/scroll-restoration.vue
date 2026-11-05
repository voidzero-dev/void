<script setup lang="ts">
import { action, Form, Link, useForm } from '@void/vue';
import type { Props } from './scroll-restoration.server.ts';
defineProps<Props>();
const form = useForm('/scroll-restoration?touch', {});
</script>

<template>
  <div>
    <h1>Scroll restoration</h1>
    <p>Scroll down, follow a link, then use the browser Back button.</p>
    <output data-testid="scroll-request">{{ requestId }}</output>
    <section v-for="row in 80" :key="row" :data-testid="`scroll-row-${row}`" style="height: 120px">
      <h2 style="margin: 0">Row {{ row }}</h2>
      <a href="/users">Go to Users</a>
      <Link href="/users">Visit Users</Link>
      <div v-if="row === 30">
        <button @click="action('/scroll-restoration?touch')">Update action</button>
        <button @click="action('/scroll-restoration?touch', { preserveScroll: false })">
          Reset action scroll
        </button>
        <button @click="action('/scroll-restoration?redirect')">Redirect action</button>
        <Form :form="form"><button type="submit">Update form</button></Form>
      </div>
    </section>
  </div>
</template>

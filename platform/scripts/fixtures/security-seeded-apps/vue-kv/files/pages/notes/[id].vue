<script setup lang="ts">
import type { Props } from './[id].server.ts';

defineProps<Props>();
</script>

<template>
  <article>
    <h1>{{ note.title }}</h1>
    <p style="white-space: pre-wrap">{{ note.body }}</p>
  </article>
</template>

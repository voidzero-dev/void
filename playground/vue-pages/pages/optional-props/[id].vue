<script setup lang="ts">
import { Link } from '@void/vue';
import { ref } from 'vue';

const props = defineProps<{ title: string; note?: string }>();
const draft = ref('');
</script>

<template>
  <section id="optional-props">
    <h1>{{ props.title }}</h1>
    <p>{{ props.note }}</p>
    <label>Draft <input v-model="draft" /></label>
    <Link href="/optional-props/second" preserve-state>Show note</Link>
  </section>
</template>

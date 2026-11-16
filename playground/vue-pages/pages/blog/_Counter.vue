<script setup lang="ts">
import { ref } from 'vue';

const props = withDefaults(defineProps<{ initial?: number; createdAt?: Date }>(), { initial: 0 });
const count = ref(props.initial);
</script>

<template>
  <div>
    <span data-testid="island-date">{{ props.createdAt?.toISOString() }}</span>
    <span data-testid="count">Count: {{ count }}</span>
    <button @click="count++">Increment</button>
  </div>
</template>

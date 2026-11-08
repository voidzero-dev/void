<script setup lang="ts">
import type { Props } from './deferred.server.ts';

defineProps<Props>();
</script>

<template>
  <div>
    <h1>{{ title }}</h1>
    <p data-testid="page-date">{{ createdAt.toISOString() }}</p>
    <div v-if="stats.loading" data-testid="deferred-loading">Loading stats...</div>
    <div v-else-if="stats.error" data-testid="deferred-error">Error: {{ stats.error.message }}</div>
    <div v-else data-testid="deferred-resolved">
      Count: {{ stats.value.count
      }}<span data-testid="deferred-date">{{ stats.value.date.toISOString() }}</span>
    </div>
  </div>
</template>

<script lang="ts">
  import type { Props } from "./deferred.server.ts";

  let { title, stats, createdAt }: Props = $props();
</script>

<div>
  <h1>{title}</h1>
  <p data-testid="page-date">{createdAt.toISOString()}</p>
  {#if stats.loading}
    <div data-testid="deferred-loading">Loading stats...</div>
  {:else if stats.error}
    <div data-testid="deferred-error">Error: {stats.error.message}</div>
  {:else}
    <div data-testid="deferred-resolved">Count: {stats.value.count}<span data-testid="deferred-date">{stats.value.date.toISOString()}</span></div>
  {/if}
</div>

<script lang="ts">
  let { initial = 0, createdAt }: { initial?: number; createdAt?: Date } = $props();
  let count = $state(0);
  $effect(() => { count = initial; });
</script>

<div>
  <span data-testid="island-date">{createdAt?.toISOString()}</span>
  <span data-testid="count">Count: {count}</span>
  <button onclick={() => count++}>Increment</button>
</div>

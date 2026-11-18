<script lang="ts">
  import type { Props } from "./dashboard.server.ts";

  let { email, role }: Props = $props();
</script>

<h1>Dashboard</h1>
<p>Signed in as {email} ({role})</p>
{#if role === "admin"}
  <a href="/api/admin/export">Export accounts</a>
{/if}

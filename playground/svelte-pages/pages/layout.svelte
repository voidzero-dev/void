<script lang="ts">
  import { Link, useShared } from "@void/svelte";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
  const shared = useShared();
</script>

<div>
  <nav>
    <Link href="/" prefetch>Home</Link> | <Link href="/users" activeMatch="prefix" prefetch>Users</Link> |
    <Link href="/blog" prefetch>Blog</Link> |
    <Link href="/deferred" prefetch>Deferred</Link> |
    <span>{shared.appName}</span>
  </nav>
  <hr />
  {@render children()}
</div>

<script setup lang="ts">
import { Link, useShared } from '@void/vue';

const shared = useShared();
</script>

<template>
  <div>
    <nav>
      <Link href="/" prefetch>Home</Link> |
      <Link href="/users" active-match="prefix" prefetch>Users</Link> |
      <Link href="/blog" prefetch>Blog</Link> | <Link href="/deferred" prefetch>Deferred</Link> |
      <span>{{ shared.appName }}</span>
    </nav>
    <hr />
    <slot />
  </div>
</template>

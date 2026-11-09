<script setup lang="ts">
import Counter from './_Counter.vue' with { island: 'load' };
import PostForm from './_PostForm.vue' with { island: 'load' };

type Props = {
  posts: Array<{ slug: string; title: string }>;
};

defineProps<Props>();
</script>

<template>
  <div>
    <h1>Blog</h1>
    <Counter :initial="0" :created-at="new Date('2026-11-08T00:00:00Z')" />
    <h2>Posts</h2>
    <ul>
      <li v-for="post in posts" :key="post.slug">
        <a :href="`/blog/${post.slug}`">{{ post.title }}</a>
      </li>
    </ul>
    <h2>New Post</h2>
    <PostForm />
  </div>
</template>

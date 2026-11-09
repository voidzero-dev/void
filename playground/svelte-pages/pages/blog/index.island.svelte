<script lang="ts">
  import Counter from "./_Counter.svelte" with { island: "load" };
  import PostForm from "./_PostForm.svelte" with { island: "load" };

  type Props = {
    posts: Array<{ slug: string; title: string }>;
  };

  let { posts }: Props = $props();
</script>

<div>
  <h1>Blog</h1>
  <Counter initial={0} createdAt={new Date("2026-11-08T00:00:00Z")} />
  <h2>Posts</h2>
  <ul>
    {#each posts as post (post.slug)}
      <li><a href="/blog/{post.slug}">{post.title}</a></li>
    {/each}
  </ul>
  <h2>New Post</h2>
  <PostForm />
</div>

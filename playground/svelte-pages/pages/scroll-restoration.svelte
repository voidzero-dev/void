<script lang="ts">
  import { action, Form, Link, useForm } from "@void/svelte";
  import type { Props } from "./scroll-restoration.server.ts";
  let { requestId, page }: Props = $props();
  const form = useForm("/scroll-restoration?touch", {});
  const anchorForm = useForm("/scroll-restoration?typedAnchor", {});
  const rows = Array.from({ length: 80 }, (_, index) => index + 1);
</script>

<div>
  <h1>Scroll restoration</h1>
  <p>Scroll down, follow a link, then use the browser Back button.</p>
  <output data-testid="scroll-request">{requestId}</output>
  <output data-testid="scroll-page">{page}</output>
  <button onclick={() => action("/scroll-restoration?anchor")}>Redirect to anchor</button>
  <Form form={anchorForm}><button type="submit">Submit to anchor</button></Form>
  {#each rows as row (row)}
    <section id={row === 60 ? "details" : undefined} data-testid={`scroll-row-${row}`} style="height: 120px">
      <h2 style="margin: 0">Row {row}</h2>
      <a href="/users">Go to Users</a>
      <Link href="/users">Visit Users</Link>
      {#if row === 30}
        <div>
          <button onclick={() => action("/scroll-restoration?touch")}>Update action</button>
          <button onclick={() => action("/scroll-restoration?touch", { preserveScroll: false })}>Reset action scroll</button>
          <button onclick={() => action("/scroll-restoration?redirect")}>Redirect action</button>
          <Form {form}><button type="submit">Update form</button></Form>
        </div>
      {/if}
    </section>
  {/each}
</div>

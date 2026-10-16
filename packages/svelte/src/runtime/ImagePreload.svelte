<script lang="ts">
  import type { HTMLLinkAttributes } from "svelte/elements";
  import type { ImagePreloadLink } from "void/image";

  let { link }: { link: ImagePreloadLink } = $props();

  // The values come from the `<img>` attributes, so they are valid link values.
  // The template sets each attribute explicitly: with a spread, Svelte adds
  // inline onload/onerror capture handlers to the server-rendered <link>.
  const preload = $derived(
    link as ImagePreloadLink &
      Pick<HTMLLinkAttributes, "crossorigin" | "referrerpolicy" | "fetchpriority">,
  );
</script>

<svelte:head>
  <link
    rel="preload"
    as="image"
    href={preload.href}
    imagesrcset={preload.imagesrcset}
    imagesizes={preload.imagesizes}
    crossorigin={preload.crossorigin}
    referrerpolicy={preload.referrerpolicy}
    fetchpriority={preload.fetchpriority}
  />
</svelte:head>

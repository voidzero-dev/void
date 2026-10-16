<script lang="ts">
  import { Image } from "@void/svelte";
  import importedPhoto from "../assets/void-image-import.png?image";

  let showPreload = $state(true);
</script>

<div>
  <h1>Images</h1>
  <Image
    src="/void-image-test.png"
    alt="Void image test"
    width={640}
    height={320}
    data-testid="image-fixed"
  />
  {#if showPreload}
    <Image
      src="/void-image-test.png"
      alt="Void image preload"
      width={480}
      height={240}
      preload
      data-testid="image-preload"
    />
  {/if}
  <!-- The same image again: the page keeps one preload link for both. -->
  <Image
    src="/void-image-test.png"
    alt="Void image preload again"
    width={480}
    height={240}
    preload
    data-testid="image-preload-again"
  />
  <button type="button" data-testid="image-preload-hide" onclick={() => (showPreload = false)}>
    Hide the first preloaded image
  </button>
  <div data-testid="image-fill-container" style="position: relative; width: 320px; height: 160px">
    <Image
      src="/void-image-test.png"
      alt="Void image fill"
      fill
      sizes="320px"
      style="object-fit: cover"
      data-testid="image-fill"
    />
  </div>
  <Image src={importedPhoto} alt="Void image import" data-testid="image-import" />
</div>

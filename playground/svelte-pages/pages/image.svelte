<script lang="ts">
  import { Image } from "@void/svelte";
  import importedPhoto from "../assets/void-image-import.png?image";
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
  <Image
    src="/void-image-test.png"
    alt="Void image preload"
    width={480}
    height={240}
    preload
    data-testid="image-preload"
  />
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

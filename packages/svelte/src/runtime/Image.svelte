<script lang="ts">
  import { getContext, onMount, untrack } from "svelte";
  import {
    getImageConfig,
    getImagePreloadLink,
    handleImageLoading,
    resolveImageProps,
    type HandleImageLoadingOptions,
  } from "void/image";
  import {
    createImageLoadEvent,
    getImgAttributes,
    toCoreImageProps,
    type ImageProps,
  } from "./image.ts";
  import {
    IMAGE_PRELOADS_KEY,
    claimImagePreload,
    releaseImagePreload,
    type ImagePreloadClaim,
    type ImagePreloads,
  } from "./image-preloads.ts";
  import ImagePreload from "./ImagePreload.svelte";

  type ImageEvent = Event & { currentTarget: EventTarget & HTMLImageElement };

  let { onload = undefined, onerror = undefined, ...props }: ImageProps = $props();

  let img = $state<HTMLImageElement | null>(null);
  let blurComplete = $state(false);
  let showAltText = $state(false);

  const resolved = $derived(
    resolveImageProps(toCoreImageProps(props), { blurComplete, showAltText }),
  );
  const attributes = $derived(getImgAttributes(resolved));
  const preloadLink = $derived(getImagePreloadLink(resolved.props, resolved.meta));
  const preloadKey = $derived(preloadLink?.key);

  // One preload link per image in a render: the first `Image` that claims a
  // key renders the link, and the next one takes over when it unmounts or
  // changes image. Claiming during init keeps server rendering and
  // hydration in the same order; `$effect.pre` runs on the client only.
  const preloads = getContext<ImagePreloads | undefined>(IMAGE_PRELOADS_KEY);
  let ownsPreload = $state(false);
  const preloadClaim: ImagePreloadClaim = {
    promote() {
      ownsPreload = true;
    },
  };
  ownsPreload = claimImagePreload(
    preloads,
    preloadClaim,
    untrack(() => preloadKey),
  );
  $effect.pre(() => {
    ownsPreload = claimImagePreload(preloads, preloadClaim, preloadKey);
    return () => releaseImagePreload(preloads, preloadClaim);
  });

  function loadingOptions(): HandleImageLoadingOptions<HTMLImageElement> {
    return {
      placeholder: resolved.meta.placeholder,
      unoptimized: resolved.meta.unoptimized,
      sizesInput: props.sizes,
      dev: getImageConfig().dev,
      onBlurComplete() {
        blurComplete = true;
      },
      onLoad(target) {
        onload?.(createImageLoadEvent(target));
        props.onLoadingComplete?.(target);
      },
    };
  }

  function handleLoad(event: Event) {
    handleImageLoading((event as ImageEvent).currentTarget, loadingOptions());
  }

  function handleError(event: Event) {
    // If the image fails to load, show the alt text and drop the placeholder.
    showAltText = true;
    if (resolved.meta.placeholder !== "empty") {
      blurComplete = true;
    }
    onerror?.(event as ImageEvent);
  }

  // On hydration, Svelte replays a load or error event the server-rendered
  // <img> fired earlier (through inline capture handlers), so unlike
  // `next/image` this does not reset `img.src` to retry an error. As in
  // `next/image`, an image that already finished loading is handled here,
  // which also covers pages whose CSP blocks those inline handlers.
  onMount(() => {
    if (!img) {
      return;
    }
    if (getImageConfig().dev) {
      if (!attributes.src) {
        console.error(`Image is missing required "src" property:`, img);
      }
      if (img.getAttribute("alt") === null) {
        console.error(
          `Image is missing required "alt" property. Please add Alternative Text to describe the image for screen readers and search engines.`,
        );
      }
    }
    if (img.complete) {
      handleImageLoading(img, loadingOptions());
    }
  });
</script>

<!-- No whitespace around <img>: it would render a text node next to the image. -->
<img
  bind:this={img}
  {...attributes}
  onload={handleLoad}
  onerror={handleError}
/>{#if preloadLink && ownsPreload}<ImagePreload link={preloadLink} />{/if}

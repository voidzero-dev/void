<script lang="ts">
  import { getContext, onDestroy, onMount } from "svelte";
  import {
    handleLinkClick,
    linkPrefetchStrategies,
    observeLinkVisible,
    prefetchLink,
    resolveLink,
    type VoidRouter,
  } from "void/pages-client";
  import type { LinkProps } from "./link-props.ts";

  let {
    href,
    method = "GET",
    data = undefined,
    preserveScroll = false,
    preserveState = false,
    replace = false,
    reloadDocument = false,
    viewTransition = undefined,
    prefetch: prefetchProp = false,
    cacheFor = undefined,
    onNavigate = undefined,
    children,
    onclick: onclickProp = undefined,
    onmouseenter: onMouseEnterProp = undefined,
    onmouseleave: onMouseLeaveProp = undefined,
    onfocus: onFocusProp = undefined,
    onmousedown: onMouseDownProp = undefined,
    ontouchstart: onTouchStartProp = undefined,
    style = undefined,
    ...rest
  }: LinkProps = $props();

  const router = getContext<VoidRouter>("__void_router");

  function doPrefetch() {
    prefetchLink(router, link.href, cacheFor);
  }

  function onClick(e: MouseEvent) {
    onclickProp?.(e);
    handleLinkClick(e, router, link, {
      data,
      preserveScroll,
      preserveState,
      replace,
      reloadDocument,
      viewTransition,
      onNavigate,
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let stopObserving: (() => void) | null = null;
  let el = $state<HTMLElement | null>(null);

  function onMouseEnter(e: MouseEvent) {
    onMouseEnterProp?.(e);
    if (e.defaultPrevented) {
      return;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
  }

  function onMouseLeave(e: MouseEvent) {
    onMouseLeaveProp?.(e);
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onFocus(e: FocusEvent) {
    onFocusProp?.(e);
    if (!e.defaultPrevented) {
      doPrefetch();
    }
  }

  function onMouseDown(e: MouseEvent) {
    onMouseDownProp?.(e);
    if (!e.defaultPrevented) {
      doPrefetch();
    }
  }

  function onTouchStart(e: TouchEvent) {
    onTouchStartProp?.(e);
    if (!e.defaultPrevented) {
      doPrefetch();
    }
  }

  onMount(() => {
    if (strategies.includes("mount")) {
      doPrefetch();
    }
    if (strategies.includes("visible") && el) {
      stopObserving = observeLinkVisible(el, doPrefetch);
    }
  });

  onDestroy(() => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    stopObserving?.();
  });

  const link = $derived(
    resolveLink({ href, method, data, prefetch: prefetchProp, reloadDocument }),
  );
  const strategies = $derived(linkPrefetchStrategies({ prefetch: prefetchProp, reloadDocument }));
  const resolvedStyle = $derived(
    style ? `touch-action: manipulation; ${style}` : "touch-action: manipulation",
  );
</script>

{#if link.isGet}
  <a
    bind:this={el}
    href={link.href}
    {...rest}
    style={resolvedStyle}
    onclick={onClick}
    onmouseenter={strategies.includes("hover") ? onMouseEnter : onMouseEnterProp}
    onmouseleave={strategies.includes("hover") ? onMouseLeave : onMouseLeaveProp}
    onfocus={strategies.includes("hover") ? onFocus : onFocusProp}
    onmousedown={strategies.includes("click") ? onMouseDown : onMouseDownProp}
    ontouchstart={strategies.includes("hover") || strategies.includes("click")
      ? onTouchStart
      : onTouchStartProp}
  >
    {@render children()}
  </a>
{:else}
  <button
    bind:this={el}
    type="button"
    {...rest}
    style={resolvedStyle}
    onclick={onClick}
    onmouseenter={strategies.includes("hover") ? onMouseEnter : onMouseEnterProp}
    onmouseleave={strategies.includes("hover") ? onMouseLeave : onMouseLeaveProp}
    onfocus={strategies.includes("hover") ? onFocus : onFocusProp}
    onmousedown={strategies.includes("click") ? onMouseDown : onMouseDownProp}
    ontouchstart={strategies.includes("hover") || strategies.includes("click")
      ? onTouchStart
      : onTouchStartProp}
  >
    {@render children()}
  </button>
{/if}

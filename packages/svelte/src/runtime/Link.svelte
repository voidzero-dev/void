<script lang="ts">
  import { getContext, onDestroy, onMount } from "svelte";
  import {
    isModifiedEvent,
    mergeDataIntoHref,
    type PrefetchOptions,
    type VoidRouter,
  } from "void/pages-client";
  import type { LinkMethod, LinkProps, PrefetchStrategy } from "./link-props.ts";

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

  function getStrategies(): Array<PrefetchStrategy> {
    if (prefetchProp !== false && !isGet) {
      throw new Error(
        'Link: prefetch only supports GET links. Remove `prefetch` or use method="GET".',
      );
    }
    if (reloadDocument && !isGet) {
      throw new Error("Link: reloadDocument only supports GET links.");
    }
    if (prefetchProp === false || reloadDocument) {
      return [];
    }
    if (prefetchProp === true) {
      return ["hover"];
    }
    if (typeof prefetchProp === "string") {
      return [prefetchProp];
    }
    return prefetchProp;
  }

  function doPrefetch() {
    if (!router?.prefetch) {
      return;
    }
    const current = window.location.pathname + window.location.search;
    if (hrefWithData === current) {
      return;
    }
    const options: PrefetchOptions = { method: normalizedMethod };
    if (cacheFor !== undefined) {
      options.cacheFor = cacheFor;
    }
    router.prefetch(hrefWithData, options);
  }

  function onClick(e: MouseEvent) {
    onclickProp?.(e);
    if (reloadDocument || !router || e.defaultPrevented || isModifiedEvent(e)) {
      return;
    }
    if ((e.currentTarget as HTMLElement).hasAttribute("download")) {
      return;
    }
    const url = new URL(hrefWithData, window.location.href);
    if (url.origin !== window.location.origin) {
      return;
    }

    let navigatePrevented = false;
    onNavigate?.({
      preventDefault() {
        navigatePrevented = true;
      },
    });
    if (navigatePrevented) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    router.visit(hrefWithData, {
      method: normalizedMethod,
      data: isGet ? undefined : data,
      preserveScroll,
      preserveState,
      replace,
      viewTransition,
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: IntersectionObserver | null = null;
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
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            doPrefetch();
            observer?.disconnect();
            observer = null;
          }
        },
        { rootMargin: "0px" },
      );
      observer.observe(el);
    }
  });

  onDestroy(() => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  });

  const normalizedMethod = $derived(method.toUpperCase() as LinkMethod);
  const isGet = $derived(normalizedMethod === "GET");
  const hrefWithData = $derived(isGet ? mergeDataIntoHref(href, data) : href);
  const strategies = $derived(getStrategies());
  const resolvedStyle = $derived(
    style ? `touch-action: manipulation; ${style}` : "touch-action: manipulation",
  );
</script>

{#if isGet}
  <a
    bind:this={el}
    href={hrefWithData}
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

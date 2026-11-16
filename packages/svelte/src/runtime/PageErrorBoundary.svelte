<script>
  import { untrack, getContext, setContext } from 'svelte';
  import { clientPageError, showTerminalPageError } from 'void/pages-client';
  let {
    boundary,
    generation = 0,
    onFailure,
    children,
    terminal = false,
    url,
    server = false,
    dev = false,
  } = $props();
  const escalate = getContext('__void_boundary_escalate');
  let Fallback = $state(null);
  let loadRequest = $state.raw(null);
  let escalated = $state(null);
  let hasEscalated = $state(false);
  setContext('__void_boundary_escalate', (error) => {
    escalated = error;
    hasEscalated = true;
  });
  function raise(error) {
    throw error;
  }
  function forward(error) {
    if (escalate) {
      escalate(error);
    } else {
      showTerminalPageError(url);
    }
  }
  let failedGeneration = null;
  let resetBoundary = () => {};
  $effect(() => {
    const next = generation;
    if (failedGeneration !== null && failedGeneration !== next) {
      failedGeneration = null;
      escalated = null;
      hasEscalated = false;
      loadRequest = null;
      Fallback = null;
      untrack(() => resetBoundary());
    }
  });
  $effect(() => {
    const request = loadRequest;
    if (!request) {
      return;
    }
    let cancelled = false;
    request.load().then(
      (module) => {
        if (!cancelled) {
          Fallback = module.default;
        }
      },
      (error) => {
        if (!cancelled) {
          forward(error);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  });
  function handleFailure(error, reset) {
    if (server || failedGeneration === generation || (!boundary && !terminal)) {
      throw error;
    }
    failedGeneration = generation;
    resetBoundary = reset;
    if (terminal) {
      showTerminalPageError(url);
    } else {
      onFailure?.();
      loadRequest = boundary;
    }
  }
</script>

<svelte:boundary onerror={handleFailure}>
  {#if hasEscalated}
    {raise(escalated)}
  {:else}
    {@render children?.()}
  {/if}
  {#snippet failed(error)}
    {#if boundary}
      <!-- Failed-snippet async errors need an explicit route to the parent. -->
      <svelte:boundary onerror={forward}>
        {#if Fallback}
          <Fallback error={clientPageError(error, dev)} />
        {/if}
      </svelte:boundary>
    {/if}
  {/snippet}
</svelte:boundary>

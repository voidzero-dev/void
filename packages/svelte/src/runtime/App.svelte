<script>
  import { setContext, onMount, untrack } from "svelte";
  import PageErrorBoundary from "./PageErrorBoundary.svelte";
  import { pageBoundarySlots } from "void/pages-client";
  import { createRouterFacade, idleNavigationState } from "void/pages-client";

  let props = $props();

  // Extract initial values without reactive tracking.
  // These are one-time snapshots used to seed $state — on the client,
  // store subscriptions in onMount take over reactivity.
  const init = untrack(() => ({
    page: props.page,
    layouts: props.layouts,
    pageProps: props.pageProps,
    shared: props.shared,
    params: props.params,
    frontmatter: props.frontmatter,
    router: props.router,
    routeUrl: props.routeUrl,
    navigation: props.navigation,
    stores: props.stores,
    pageId: props.pageId,
    boundaryManifest: props.boundaryManifest,
    components: props.components,
    server: props.server,
  }));

  // Local reactive state — initialized from props, updated by stores on client
  let currentPage = $state(init.page);
  let currentPageId = $state(init.pageId);
  let generation = $state(0);
  let boundaries = $derived(
    pageBoundarySlots(init.boundaryManifest, currentPageId, init.components || {}),
  );
  let currentLayouts = $state(init.layouts);
  let currentPageProps = $state(init.pageProps);
  let shared = $state(init.shared);
  let params = $state(init.params || {});
  let routeUrl = $state(init.routeUrl || "/");
  let navigation = $state(init.navigation || idleNavigationState());
  const router = init.router ? createRouterFacade(init.router, () => routeUrl, () => params) : null;

  // Pages and layouts keep the objects returned by useShared() and useParams()
  // across navigations, so update them in place.
  function replaceInPlace(target, next) {
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, next || {});
  }

  // Capitalized alias for dynamic component rendering
  let Page = $derived(currentPage);

  // Provide context for child components (useShared, useRouter, useForm)
  setContext("__void_shared", {
    get value() { return shared; },
  });
  setContext("__void_params", {
    get value() { return params; },
  });
  setContext("__void_router", router);
  setContext("__void_navigation", {
    get value() { return navigation; },
  });
  // Island pages pass Markdown frontmatter so layouts can read it (useFrontmatter).
  if (init.frontmatter) {
    setContext("__void_frontmatter", init.frontmatter);
  }

  // Client mode: subscribe to stores for live updates after hydration.
  // onMount only runs on the client, not during SSR.
  onMount(() => {
    if (!init.stores) {return;}
    const unsubs = [
      ...(init.stores.boundaryGeneration
        ? [init.stores.boundaryGeneration.subscribe((v) => { generation = v; })]
        : []),
      ...(init.stores.pageId
        ? [init.stores.pageId.subscribe((v) => { currentPageId = v; })]
        : []),
      init.stores.page.subscribe((v) => { currentPage = v; }),
      init.stores.props.subscribe((v) => { currentPageProps = v; }),
      init.stores.layouts.subscribe((v) => { currentLayouts = v; }),
      init.stores.shared.subscribe((v) => replaceInPlace(shared, v)),
      init.stores.params.subscribe((v) => replaceInPlace(params, v)),
      init.stores.route.subscribe((v) => { routeUrl = v; }),
      init.stores.navigation.subscribe((v) => { navigation = v; }),
    ];
    return () => unsubs.forEach((u) => u());
  });
</script>

{#if Page}
  {#if init.boundaryManifest && Object.keys(init.boundaryManifest.plans).length}
    <PageErrorBoundary terminal url={routeUrl} server={init.server} {generation}>
      {@render boundaryChain(0, 0)}
    </PageErrorBoundary>
  {:else}
    {@render content(0)}
  {/if}
{/if}

{#snippet boundaryChain(depth, offset)}
  {@const atDepth = boundaries.filter(b => b.depth === depth).toReversed()}
  {#if offset < atDepth.length}
    <PageErrorBoundary
      boundary={atDepth[offset]}
      {generation}
      server={init.server}
      dev={props.dev}
      onFailure={() => router?.flush(routeUrl)}
    >
      {@render boundaryChain(depth, offset + 1)}
    </PageErrorBoundary>
  {:else}
    {@render content(depth)}
  {/if}
{/snippet}

{#snippet content(index)}
  {#if index < currentLayouts.length}
    {@const Layout = currentLayouts[index]}
    <Layout>
      {@render boundaryChain(index + 1, 0)}
    </Layout>
  {:else}
    <Page {...currentPageProps} />
  {/if}
{/snippet}

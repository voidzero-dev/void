<script>
  import { setContext, onMount, untrack } from "svelte";
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
  }));

  // Local reactive state — initialized from props, updated by stores on client
  let currentPage = $state(init.page);
  let currentLayouts = $state(init.layouts);
  let currentPageProps = $state(init.pageProps);
  let shared = $state(init.shared);
  let params = $state(init.params || {});
  let routeUrl = $state(init.routeUrl || "/");
  let navigation = $state(init.navigation || idleNavigationState());
  const router = createRouterFacade(init.router, () => routeUrl, () => params);

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
  {#if currentLayouts.length > 0}
    {@render layoutChain(currentLayouts, 0)}
  {:else}
    <Page {...currentPageProps} />
  {/if}
{/if}

{#snippet layoutChain(layouts, index)}
  {#if index < layouts.length}
    {@const Layout = layouts[index]}
    <Layout>
      {@render layoutChain(layouts, index + 1)}
    </Layout>
  {:else}
    <Page {...currentPageProps} />
  {/if}
{/snippet}

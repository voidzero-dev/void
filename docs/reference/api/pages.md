---
outline: deep
---

# Pages Adapters {#framework-adaptors}

Framework adaptors for [Pages Routing](../../guide/pages-routing/overview). Each adaptor provides a Vite plugin and client-side runtime.

## `@void/vue` {#void-vue}

### `voidVue(options?)` {#voidvue-options}

Imported from `"@void/vue/plugin"`. Returns an array of Vite plugins that handle Vue SFC compilation and SSR or hydration entry generation. It already includes `@vitejs/plugin-vue`, so you do not need to install or configure that separately.

```ts
import { voidVue } from '@void/vue/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

**Signature:**

```ts
function voidVue(options?: VoidVueOptions): Plugin[];
```

**Options:**

```ts
interface VoidVueOptions {
  vue?: VuePluginOptions; // passed through to @vitejs/plugin-vue
  viewTransitions?: boolean; // enable View Transitions API for navigations
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### Vue Runtime {#vue-runtime}

Imported from `"@void/vue"`.

| Export                             | Description                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | Vue component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `Image`                            | Optimized `<img>` with the props of `next/image`: `src`, `alt`, `width`, `height`, `fill`, `sizes`, `quality`, `preload`, `placeholder`, `loader`, `unoptimized`, `@load`, `@error`, and more. See [Images](../../guide/images.md).               |
| `getImageProps(props)`             | Returns `{ props }`, the attributes `Image` would render, with HTML names (`srcset`, `class`, `style` as a string) for `v-bind`.                                                                                                                  |
| `useRouter()`                      | Returns the Void Router with current route state (`url`, `path`, `query`, `params`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`.                                                                        |
| `useParams()`                      | Returns dynamic route params for the page currently being rendered.                                                                                                                                                                               |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                             |
| `useForm(url, defaults, options?)` | Typed reactive form helper bound to a page action URL. Returns `{ data, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                       |
| `useIslandForm(defaults)`          | Form helper for island components. Same form state as `useForm()`, plus `submit(url, method)`. `post(url)`, `put(url)`, `patch(url)`, and `delete(url)` take the action URL and submit with `fetch()`.                                            |
| `action(url, options?)`            | Awaitable one-shot page action helper. Uses `POST` by default and accepts `{ data, method, params }`, where `method` can be `"PUT"`, `"PATCH"`, or `"DELETE"`. Returns an `ActionResult`.                                                         |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                          |

Vue `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

Vue GET navigation remounts the page so `useForm()` picks up the destination record's URL and defaults; layouts persist. Mutations and `router.refresh()` preserve page state by default. Set `preserveState` explicitly to override the default for navigation within the same record.

## `@void/react` {#void-react}

### `voidReact(options?)` {#voidreact-options}

Imported from `"@void/react/plugin"`. Returns an array of Vite plugins that handle SSR and hydration entry generation. It already includes `@vitejs/plugin-react`, so you do not need to install or configure that separately.

```ts
import { voidReact } from '@void/react/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

**Signature:**

```ts
function voidReact(options?: VoidReactOptions): Plugin[];
```

**Options:**

```ts
interface VoidReactOptions {
  react?: ReactPluginOptions; // passed through to @vitejs/plugin-react
  viewTransitions?: boolean; // enable View Transitions API for navigations
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### React Runtime {#react-runtime}

Imported from `"@void/react"`.

| Export                             | Description                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | React component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `Image`                            | Optimized `<img>` with the props of `next/image`: `src`, `alt`, `width`, `height`, `fill`, `sizes`, `quality`, `preload`, `placeholder`, `loader`, `unoptimized`, `onLoad`, `onError`, and more. See [Images](../../guide/images.md).               |
| `getImageProps(props)`             | Returns `{ props }`, the attributes `Image` would render, with React names (`srcSet`, `className`, `style` object).                                                                                                                                 |
| `useRouter()`                      | Returns the Void Router with current route state (`url`, `path`, `query`, `params`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`. React navigations are scheduled as transitions.                          |
| `useParams()`                      | Returns dynamic route params for the page currently being rendered.                                                                                                                                                                                 |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                               |
| `useForm(url, defaults, options?)` | Form helper hook. Returns `{ data, setData, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                                                     |
| `useIslandForm(defaults)`          | Form helper hook for island components. Same form state as `useForm()`. `post(url)`, `put(url)`, `patch(url)`, and `delete(url)` take the action URL and submit with `fetch()`.                                                                     |
| `action(url, options?)`            | Awaitable one-shot page action helper. Uses `POST` by default and accepts `{ data, method, params }`, where `method` can be `"PUT"`, `"PATCH"`, or `"DELETE"`. Returns an `ActionResult`.                                                           |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                            |
| `Deferred<T>`                      | React-only prop type for `defer()` results. It is `Promise<T>` and is consumed with React `use()`.                                                                                                                                                  |

React `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

React deferred props returned from `defer()` are Suspense resources. Read them
with React's `use()` inside a `<Suspense>` boundary. React Pages requires React
19 and uses streaming SSR for the initial deferred shell. Rejections throw from
`use()`, so use a normal React error boundary for custom deferred error UI. Vue,
Svelte, and Solid keep the `{ loading, value, error }` deferred state object.
When explicitly annotating props, import `Deferred` from the framework adapter
package (`@void/react`, `@void/vue`, `@void/svelte`, or `@void/solid`) so the
type matches that adapter's client runtime shape.

## `@void/svelte` {#void-svelte}

### `voidSvelte(options?)` {#voidsvelte-options}

Imported from `"@void/svelte/plugin"`. Returns an array of Vite plugins that handle SSR and hydration entry generation for Svelte 5. It already includes `@sveltejs/vite-plugin-svelte`, so you do not need to install or configure that separately.

```ts
import { voidSvelte } from '@void/svelte/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

**Signature:**

```ts
function voidSvelte(options?: VoidSvelteOptions): Plugin[];
```

**Options:**

```ts
interface VoidSvelteOptions {
  svelte?: SveltePluginOptions; // passed through to @sveltejs/vite-plugin-svelte
  viewTransitions?: boolean; // enable View Transitions API
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### Svelte Runtime {#svelte-runtime}

Imported from `"@void/svelte"`.

| Export                             | Description                                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | Svelte component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `Image`                            | Optimized `<img>` with the props of `next/image`: `src`, `alt`, `width`, `height`, `fill`, `sizes`, `quality`, `preload`, `placeholder`, `loader`, `unoptimized`, `onload`, `onerror`, and more. See [Images](../../guide/images.md).                |
| `getImageProps(props)`             | Returns `{ props }`, the attributes `Image` would render, with HTML names (`srcset`, `class`, `style` as a string) for spreading onto an element.                                                                                                    |
| `useForm(url, defaults, options?)` | Form helper using Svelte 5 runes. Returns `{ data, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                                               |
| `useIslandForm(defaults)`          | Form helper for island components. Same form state as `useForm()`, plus `submit(url, method)`. `post(url)`, `put(url)`, `patch(url)`, and `delete(url)` take the action URL and submit with `fetch()`.                                               |
| `action(url, options?)`            | Awaitable one-shot page action helper. Uses `POST` by default and accepts `{ data, method, params }`, where `method` can be `"PUT"`, `"PATCH"`, or `"DELETE"`. Returns an `ActionResult`.                                                            |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                             |
| `useRouter()`                      | Returns the Void Router with current route state (`url`, `path`, `query`, `params`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`.                                                                           |
| `useParams()`                      | Returns dynamic route params for the page currently being rendered.                                                                                                                                                                                  |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                                |

Svelte `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

## `@void/solid` {#void-solid}

### `voidSolid(options?)` {#voidsolid-options}

Imported from `"@void/solid/plugin"`. Returns an array of Vite plugins that handle SSR and hydration entry generation for Solid. It already includes `vite-plugin-solid`, so you do not need to install or configure that separately.

```ts
import { voidSolid } from '@void/solid/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

**Signature:**

```ts
function voidSolid(options?: VoidSolidOptions): Plugin[];
```

**Options:**

```ts
interface VoidSolidOptions {
  solid?: SolidPluginOptions; // passed through to vite-plugin-solid
  viewTransitions?: boolean; // enable View Transitions API
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### Solid Runtime {#solid-runtime}

Imported from `"@void/solid"`.

| Export                             | Description                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | Solid component for SPA navigation. Renders `<a>` for GET, `<button>` for non-GET methods. Props: `href`, `method`, `data`, `prefetch`, `cacheFor`, `preserveScroll`, `preserveState`, `replace`, `reloadDocument`, `viewTransition`, `onNavigate`. |
| `Image`                            | Optimized `<img>` with the props of `next/image`: `src`, `alt`, `width`, `height`, `fill`, `sizes`, `quality`, `preload`, `placeholder`, `loader`, `unoptimized`, `onLoad`, `onError`, and more. See [Images](../../guide/images.md).               |
| `getImageProps(props)`             | Returns `{ props }`, the attributes `Image` would render, with HTML names (`srcset`, `class`, `style` as a string) for spreading onto an element.                                                                                                   |
| `useForm(url, defaults, options?)` | Form helper using Solid stores. Returns `{ data, setData, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, clearErrors, clearError }`.                                                       |
| `useIslandForm(defaults)`          | Form helper for island components. Same form state as `useForm()`. `post(url)`, `put(url)`, `patch(url)`, and `delete(url)` take the action URL and submit with `fetch()`.                                                                          |
| `action(url, options?)`            | Awaitable one-shot page action helper. Uses `POST` by default and accepts `{ data, method, params }`, where `method` can be `"PUT"`, `"PATCH"`, or `"DELETE"`. Returns an `ActionResult`.                                                           |
| `useShared()`                      | Returns shared data injected by middleware via `c.set("shared", {...})`.                                                                                                                                                                            |
| `useRouter()`                      | Returns the Void Router with current route state (`url`, `path`, `query`, `params`) and navigation methods: `visit`, `refresh`, awaitable `prefetch`, `flush`, `flushAll`.                                                                          |
| `useParams()`                      | Returns dynamic route params for the page currently being rendered.                                                                                                                                                                                 |
| `useNavigation()`                  | Returns pending navigation state: `{ state, location, method }`, where `state` is `"idle"`, `"loading"`, or `"submitting"` and `location` is the pending destination.                                                                               |

Solid `Link` GET `data` is merged into the rendered `href` query string. Primitive values are serialized with `String(value)`, arrays become repeated keys, `null` and `undefined` are omitted, and nested objects throw. `prefetch` and `reloadDocument` are GET-only and throw for mutation links.

Solid re-creates the page on GET navigation and whenever the route or its params change, so `useForm()` picks up the destination record's URL and defaults; layouts persist. Within the same record, back/forward, mutations, and `router.refresh()` keep the page and update its props in place, as do resolved deferred props, so read props inside JSX or memos instead of copying them in the component body. Set `preserveState` explicitly to override the default for navigation within the same record.

## Markdown Package {#markdown-package}

The optional `@void/md` package adds Markdown pages to Pages Routing. Install it alongside a Pages adapter and add `voidMarkdown()` to your Vite plugins.

```ts
import { voidMarkdown } from '@void/md/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidReact(), voidMarkdown()],
});
```

| Import path                  | Contents                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `@void/md/plugin`            | `voidMarkdown(options?)`, `MarkdownOptions`, `MdPage`                                    |
| `@void/md`                   | `useFrontmatter()`, `MdPage`                                                             |
| `@void/md/pages`             | Generated metadata for Markdown pages, used for navigation, sidebars, and search indexes |
| `@void/md/theme.css`         | Full Markdown theme styles                                                               |
| `@void/md/theme-content.css` | Content-only Markdown styles for apps that provide their own shell/layout                |

`FrontmatterContext` and `setFrontmatter()` are deprecated. Use `useFrontmatter()`.

See [Markdown Pages](../../guide/pages-routing/markdown.md) for setup and framework-specific examples.

## Form

Each Pages adapter exports `Form`. Pass the object returned by `useForm()` as `form`; `method` defaults to `post`. It renders validation and action errors, preserves controlled input, and respects known quota retry deadlines without submitting automatically. `renderError` customizes action-error presentation; Svelte uses a snippet. See [Actions and Forms](../../guide/pages-routing/actions-and-forms.md).

## Image

Each Pages adapter exports `Image` and `getImageProps()`. They accept the props of `next/image` in Next.js 16 and render the same `<img>` markup, served by the `/_void/image` endpoint or a configured loader. Event and attribute names follow each framework: `@load` and `@error` in Vue, `onload` and `onerror` in Svelte, and `onLoad` and `onError` in React and Solid.

`@void/react/image` has the same exports as the `next/image` module: `Image` as the default export, `getImageProps`, and the `ImageProps`, `ImageLoader`, `ImageLoaderProps`, and `StaticImageData` types. Configure images with [`images`](../config.md#images). See [Images](../../guide/images.md) for usage.

`@void/solid` also exports `ImagePreloadContext`, which collects preload links in [custom SSR](../../guide/images.md#custom-ssr) apps.

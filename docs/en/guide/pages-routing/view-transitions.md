---
outline: deep
---

# View Transitions

Add animated page transitions with the browser’s [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API). Pages cross-fade by default; use CSS to customize the animation.

## Enabling View Transitions

Pass `viewTransitions: true` to the adapter plugin:

::: code-group

```ts [React]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidReact({ viewTransitions: true })],
});
```

```ts [Vue]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidVue({ viewTransitions: true })],
});
```

```ts [Svelte]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidSvelte({ viewTransitions: true })],
});
```

```ts [Solid]
// vite.config.ts
export default defineConfig({
  plugins: [voidPlugin(), voidSolid({ viewTransitions: true })],
});
```

:::

This enables view transitions for all navigations, including `Link` clicks, programmatic `router.visit()` calls, and browser back or forward.

## Per-Link Override

Override the global setting on individual links:

::: code-group

```tsx [React]
{
  /* Disable transition for this link */
}
<Link href="/settings" viewTransition={false}>
  Settings
</Link>;

{
  /* Enable for just this link (even if globally disabled) */
}
<Link href="/about" viewTransition>
  About
</Link>;
```

```vue [Vue]
<!-- Disable transition for this link -->
<Link href="/settings" :view-transition="false">Settings</Link>

<!-- Enable for just this link (even if globally disabled) -->
<Link href="/about" view-transition>About</Link>
```

```svelte [Svelte]
<!-- Disable transition for this link -->
<Link href="/settings" viewTransition={false}>Settings</Link>

<!-- Enable for just this link (even if globally disabled) -->
<Link href="/about" viewTransition>About</Link>
```

```tsx [Solid]
{
  /* Disable transition for this link */
}
<Link href="/settings" viewTransition={false}>
  Settings
</Link>;

{
  /* Enable for just this link (even if globally disabled) */
}
<Link href="/about" viewTransition>
  About
</Link>;
```

:::

Or programmatically:

```ts
router.visit('/about', { viewTransition: true });
router.visit('/settings', { viewTransition: false });
```

## Customizing with CSS

The default transition is a cross-fade. Customize it using the `::view-transition-old` and `::view-transition-new` pseudo-elements:

```css
/* Faster transition */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 0.2s;
}

/* Slide instead of fade */
::view-transition-old(root) {
  animation: slide-out 0.3s ease-in;
}
::view-transition-new(root) {
  animation: slide-in 0.3s ease-out;
}
```

Assign `view-transition-name` to elements that should animate independently (e.g., a hero image that morphs between pages):

```css
.hero-image {
  view-transition-name: hero;
}
```

::: tip
View transitions are progressive enhancement. Browsers that do not support the API fall back to instant navigation with no errors.
:::

---
outline: deep
---

# 视图过渡（View Transitions） {#view-transitions}

通过浏览器的[视图过渡 API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)，可以为页面切换添加动画。默认效果是交叉淡入淡出，也可以通过 CSS 自定义。

## 启用视图过渡 {#enabling-view-transitions}

向适配器插件传入 `viewTransitions: true`：

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

启用后，所有导航都会使用视图过渡，包括点击 `Link`、调用 `router.visit()`，以及浏览器的前进和后退。

## 单独设置链接 {#per-link-override}

你可以为单个链接覆盖全局设置：

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

也可以在代码中控制：

```ts
router.visit('/about', { viewTransition: true });
router.visit('/settings', { viewTransition: false });
```

## 通过 CSS 自定义 {#customizing-with-css}

默认过渡效果是交叉淡入淡出。通过 `::view-transition-old` 和 `::view-transition-new` 伪元素，可以自定义动画：

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

如果某个元素需要独立的过渡动画，例如在两个页面之间变换形态的主视觉图片，可以为它设置 `view-transition-name`：

```css
.hero-image {
  view-transition-name: hero;
}
```

::: tip
视图过渡是一项渐进增强功能。不支持该 API 的浏览器会直接完成页面切换，不会报错。
:::

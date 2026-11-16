---
title: Code Examples
description: Syntax highlighting demos
---

Void supports syntax highlighting with dual themes (light/dark).

## TypeScript

```ts
interface User {
  id: number;
  name: string;
  email: string;
}

async function fetchUser(id: number): Promise<User> {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
}
```

## Diff Notation

```ts
export default defineConfig({
  plugins: [
    voidPlugin(),
    voidVue(), // [!code --]
    voidVue(),
    voidMarkdown(), // [!code ++]
  ],
});
```

```tsx
<div>
  {/* [!code --] */}
  <Old />
  {/* [!code ++] */}
  <New />
</div>
```

## Line Highlighting

```ts {2,4-5}
const app = createApp();
app.use(router); // highlighted
app.use(store);
app.use(i18n); // highlighted
app.mount('#app'); // highlighted
```

## With Line Numbers

```js :line-numbers
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10));
```

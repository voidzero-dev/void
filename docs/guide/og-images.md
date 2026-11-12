---
outline: deep
---

# Open Graph Images

Use `OgImageResponse` from `void/og` to generate Open Graph and social preview images in a route handler. It draws JSX or HTML to a PNG with [Takumi](https://takumi.kane.tw/docs/), without a headless browser.

`OgImageResponse` extends [`ImageResponse`](./image-generation.md) with a default size of 1200 × 630. For other generated images, use `ImageResponse` from `void/image`.

## Create an image route

Return an `OgImageResponse` from a [`.tsx` route](./server-routing.md#jsx-handlers):

```tsx
// routes/og/[slug].tsx
import { defineHandler } from 'void';
import { OgImageResponse } from 'void/og';
import { getPost } from '../../src/posts';

export const GET = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  if (!post) {
    return c.notFound();
  }
  return new OgImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        padding: 80,
        background: '#0f172a',
        color: 'white',
      }}
    >
      <div style={{ fontSize: 72, fontWeight: 700 }}>{post.title}</div>
      <div style={{ fontSize: 36, opacity: 0.7 }}>{post.author}</div>
    </div>,
  );
});
```

`GET /og/hello-world` now returns a 1200 × 630 PNG.

JSX works in React apps. In Vue, Svelte, and Solid apps, pass an HTML string instead, as shown in [Without React](#without-react). Elements also accept Tailwind classes in a `tw` prop, such as `<div tw="flex h-full w-full items-center justify-center bg-white">`.

### Without React

Pass an HTML string instead of JSX, and escape the values you insert:

```ts
// routes/og/[slug].ts
import { defineHandler } from 'void';
import { OgImageResponse } from 'void/og';
import { getPost } from '../../src/posts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const GET = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  if (!post) {
    return c.notFound();
  }
  return new OgImageResponse(
    `<div style="display: flex; width: 100%; height: 100%; padding: 80px; font-size: 72px">
      ${escapeHtml(post.title)}
    </div>`,
  );
});
```

## Add the image to a page

Point an `og:image` tag at the route from your page's [`head()`](./pages-routing/head.md):

```ts
// pages/posts/[slug].server.ts
import { defineHead } from 'void';

export interface Props {
  post: { title: string; slug: string };
}

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.post.title,
    meta: [
      { property: 'og:image', content: new URL(`/og/${props.post.slug}`, c.req.url).href },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  };
});
```

## Options

The optional second argument sets the image and the response:

| Option   | Default | Description             |
| -------- | ------- | ----------------------- |
| `width`  | `1200`  | Image width in pixels.  |
| `height` | `630`   | Image height in pixels. |

See [Image Generation options](./image-generation.md#options) for all other options, response headers, and image-loading behavior.

## Learn More

Learn more in the [Image Generation](./image-generation.md) guide:

- [Fonts](./image-generation.md#fonts)
- [Control font downloads](./image-generation.md#control-font-downloads)
- [Cache generated images](./image-generation.md#cache-generated-images)
- [Worker size](./image-generation.md#worker-size)
- [Node.js, Bun, and Deno](./image-generation.md#node-js-bun-and-deno)

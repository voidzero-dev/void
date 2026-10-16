---
outline: deep
---

# Open Graph Images

Use `ImageResponse` from `void/og` to generate Open Graph and social preview images in a route handler. It takes the same arguments as `ImageResponse` from `next/og` and draws JSX or HTML to a PNG with [Takumi](https://takumi.kane.tw/docs/), without a headless browser.

## Create an image route

Route files are TypeScript, so put the image's JSX in a `.tsx` module:

```tsx
// src/og/post-card.tsx
export function postCard(post: { title: string; author: string }) {
  return (
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
    </div>
  );
}
```

Then return an `ImageResponse` from a route:

```ts
// routes/og/[slug].ts
import { defineHandler } from 'void';
import { ImageResponse } from 'void/og';
import { postCard } from '../../src/og/post-card';
import { getPost } from '../../src/posts';

export const GET = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  if (!post) {
    return c.notFound();
  }
  return new ImageResponse(postCard(post));
});
```

`GET /og/hello-world` now returns a 1200 × 630 PNG.

JSX in image modules compiles with React, so your app needs `react`. Elements also accept Tailwind classes in a `tw` prop, such as `<div tw="flex h-full w-full items-center justify-center bg-white">`.

### Without React

Pass an HTML string instead of JSX, and escape the values you insert:

```ts
// routes/og/[slug].ts
import { defineHandler } from 'void';
import { ImageResponse } from 'void/og';
import { getPost } from '../../src/posts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const GET = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  if (!post) {
    return c.notFound();
  }
  return new ImageResponse(
    `<div style="display: flex; width: 100%; height: 100%; padding: 80px; font-size: 72px">
      ${escapeHtml(post.title)}
    </div>`,
  );
});
```

## Options

The second argument sets the image and the response:

| Option                            | Default       | Description                                                                        |
| --------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `width`, `height`                 | `1200`, `630` | Image size in pixels.                                                              |
| `fonts`                           | Geist         | Fonts to draw text with. See [Fonts](#fonts).                                      |
| `emoji`                           | `'twemoji'`   | Emoji style: `twemoji`, `blobmoji`, `noto`, `openmoji`, `fluent`, or `fluentFlat`. |
| `debug`                           | `false`       | Draws a border around every box.                                                   |
| `format`                          | `'png'`       | Image format: `png`, `jpeg`, or `webp`.                                            |
| `status`, `statusText`, `headers` |               | The response status and headers.                                                   |

Takumi's other render options, such as `devicePixelRatio`, are passed through. See [Takumi's reference](https://takumi.kane.tw/docs/reference).

Responses have these headers unless you set them in `headers`:

```http
Content-Type: image/png
Cache-Control: public, immutable, no-transform, max-age=31536000
```

During `vp dev`, `Cache-Control` is `no-cache, no-store`.

Emoji and remote `<img>` sources are downloaded while the image renders.

## Fonts

Text uses Geist unless you pass `fonts`. When the text includes a script that Geist cannot draw, such as Japanese, Chinese, Korean, Thai, Arabic, Hebrew, Cyrillic, or Greek, Void downloads the matching Noto Sans font from Google Fonts while rendering. If the download fails, the image renders without those characters.

To use your own fonts, pass `fonts`. An entry is either a font URL or an object with the font's data, as in `next/og`:

```ts
return new ImageResponse(postCard(post), {
  fonts: [
    'https://example.com/fonts/Inter-Bold.woff2',
    { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
  ],
});
```

Fonts can be TTF, OTF, WOFF, or WOFF2 files.

## Add the image to a page

Point an `og:image` tag at the route from your page's [`head()`](./pages-routing/head.md):

```ts
// pages/posts/[slug].server.ts
import { defineHead } from 'void';

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

## Cache generated images

Each request renders the image again, which uses several milliseconds of CPU time, more for large images. [Workers Free allows 10 ms per request](../reference/config.md#worker). Cache image routes with [revalidation](./edge/revalidation.md):

```json
{
  "routing": {
    "revalidate": {
      "/og/*": 86400
    }
  }
}
```

Void never caches paths under `/api`, so serve images from another path, such as `/og/...`. The cache ignores query strings, so put values in the path, or list the query parameters in [`routing.revalidateQueryAllowlist`](../reference/config.md#routing-revalidatequeryallowlist).

## Coming from `next/og`

Change the import:

```ts
import { ImageResponse } from 'next/og'; // [!code --]
import { ImageResponse } from 'void/og'; // [!code ++]
```

Then:

- Move the JSX from `route.tsx` into a `.tsx` module and return the response from a route file, as shown above.
- Read the request from Hono's context: `c.req.url`, `c.req.param()`, and `c.req.query()`.
- Void draws images with Takumi rather than Satori, so layout can differ slightly. See [Takumi vs. Satori](https://takumi.kane.tw/docs/comparison-to-satori).

## Node.js and Bun

On the [Node.js and Bun targets](../integrations/nodejs-bun-deno.md), add `takumi-js` to your app's dependencies:

```sh
npm install takumi-js
```

The build then leaves Takumi's native renderer to the runtime. Without it, the build fails and names this step.

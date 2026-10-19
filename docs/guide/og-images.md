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

JSX works in React apps. In Vue, Svelte, and Solid apps, pass an HTML string instead, as shown in [Without React](#without-react). Elements also accept Tailwind classes in a `tw` prop, such as `<div tw="flex h-full w-full items-center justify-center bg-white">`.

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
| `lang`                            |               | Language of the text, such as `'ja'` or `'zh-TW'`, for Chinese characters.         |
| `debug`                           | `false`       | Draws a border around every box.                                                   |
| `format`                          | `'png'`       | Image format: `png`, `jpeg`, or `webp`.                                            |
| `status`, `statusText`, `headers` |               | The response status and headers.                                                   |

Takumi's other render options, such as `devicePixelRatio`, are passed through. See [Takumi's reference](https://takumi.kane.tw/docs/reference).

Responses have these headers unless you set them in `headers`:

```http
Content-Type: image/png
Cache-Control: public, immutable, no-transform, max-age=31536000
```

During `vp dev`, `Cache-Control` is `no-cache, no-store`. Images served from the [revalidation cache](#cache-generated-images) carry Void's cache headers instead.

Emoji and remote `<img>` sources are downloaded while the image renders. An emoji that the chosen style does not have fails the image; `noto` has no flags.

## Fonts

Text uses Geist unless you pass `fonts`. When the text includes characters that Geist cannot draw, such as Japanese, Chinese, Korean, Thai, Arabic, Hebrew, Cyrillic, Greek, accented letters like Ł and ş, or symbols like → and ★, Void downloads the matching Noto Sans font from Google Fonts while rendering. If the download fails, those characters are drawn as boxes.

Chinese characters are drawn in the Japanese style, as in `next/og`, unless the text has Korean or Chinese around them, or `lang` names the language:

```ts
return new ImageResponse(`<div lang="zh-TW" style="display: flex">${title}</div>`);
```

To use your own fonts, pass `fonts`. An entry is either a font URL or an object with the font's data, as in `next/og`:

```ts
return new ImageResponse(postCard(post), {
  fonts: [
    'https://example.com/fonts/Inter-Bold.woff2',
    { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
  ],
});
```

Fonts can be TTF, OTF, or WOFF2 files.

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

Each request renders the image again. A simple 1200 × 630 card takes under 10 ms of CPU time, one with gradients, bold text, or emoji 30 to 100 ms, and the first render in a new Worker instance about 200 ms more. [Workers Free allows 10 ms per request](../reference/config.md#worker) and fails requests from a Worker that keeps exceeding it, so on Workers Free, cache image routes with [revalidation](./edge/revalidation.md):

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
- Next.js 16 sends `Cache-Control: public, max-age=0, must-revalidate`; Void lets clients cache the image for a year, like `@vercel/og`. Pass `headers` to change that.
- A font's `lang` is accepted but does not choose the font for a language. Use the `lang` option or attribute for Chinese characters instead.

## Node.js, Bun, and Deno

On the [Node.js, Bun, and Deno targets](../integrations/nodejs-bun-deno.md), add `takumi-js` to your app's `dependencies`, not `devDependencies`, so production installs include it:

```sh
npm install takumi-js
```

If the build cannot find a version of `takumi-js` that Void supports, it fails and prints the command to install one.

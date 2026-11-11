---
outline: deep
---

# Open Graph Images

Use `ImageResponse` from `void/og` to generate Open Graph and social preview images in a route handler. It draws JSX or HTML to a PNG with [Takumi](https://takumi.kane.tw/docs/), without a headless browser.

## Create an image route

Return an `ImageResponse` from a [`.tsx` route](./server-routing.md#jsx-handlers):

```tsx
// routes/og/[slug].tsx
import { defineHandler } from 'void';
import { ImageResponse } from 'void/og';
import { getPost } from '../../src/posts';

export const GET = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  if (!post) {
    return c.notFound();
  }
  return new ImageResponse(
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

| Option                            | Default       | Description                                                                                                                  |
| --------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `width`, `height`                 | `1200`, `630` | Image size in pixels.                                                                                                        |
| `fonts`                           | Geist         | Fonts to draw text with. See [Fonts](#fonts).                                                                                |
| `emoji`                           | `'twemoji'`   | Emoji style: `twemoji`, `blobmoji`, `noto`, `openmoji`, `fluent`, `fluentFlat`, or `from-font` to draw emoji with the fonts. |
| `lang`                            |               | Language of the text, such as `'ja'` or `'zh-TW'`, for Chinese characters.                                                   |
| `debug`                           | `false`       | Draws a border around every box.                                                                                             |
| `format`                          | `'png'`       | Image format: `png`, `jpeg`, `webp`, or `ico`.                                                                               |
| `images`                          |               | Limits for remote images: `allowUrl`, `maxBytes`, and `timeout`. Set them when the markup includes request values.           |
| `status`, `statusText`, `headers` |               | The response status and headers.                                                                                             |

Takumi's other render options, such as `devicePixelRatio`, are passed through. See [Takumi's reference](https://takumi.kane.tw/docs/reference).

Responses have these headers unless you set them in `headers`:

```http
Content-Type: image/png
Cache-Control: public, max-age=0, must-revalidate
```

During local development, `Cache-Control` is `no-cache, no-store`. Clients revalidate the image on each use; [cache it at the edge](#cache-generated-images) so they get the cached copy.

Emoji and remote images are downloaded while the image renders. An emoji that the chosen style does not have, or an image that fails to download, fails the image unless you pass `images: { throwOnError: false }`, which leaves it out; `noto` has no flags.

## Fonts

Text uses Geist unless you pass `fonts`. When the text includes characters that Geist cannot draw, such as Japanese, Chinese, Korean, Thai, Arabic, Hebrew, Cyrillic, Greek, accented letters like Ł and ş, or symbols like → and ★, Void downloads the matching font from Google Fonts while rendering, whether or not `fonts` covers them. If the download fails, those characters are drawn as boxes.

Chinese characters are drawn in the Japanese style unless the `lang` option or the root element's `lang` attribute names the language, or the text has Korean around them. A `lang` wins over the text, so a Chinese title with a katakana word keeps the Chinese style:

```ts
return new ImageResponse(`<div lang="zh-TW" style="display: flex">${title}</div>`);
```

One style applies to all Chinese characters in an image, so an image cannot mix Japanese and Chinese styles through `lang` on inner elements.

To use your own fonts, pass `fonts`. An entry is either a font URL or an object with the font's data:

```ts
return new ImageResponse(postCard(post), {
  fonts: [
    'https://example.com/fonts/Inter-Bold.woff2',
    { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
  ],
});
```

Fonts can be TTF, OTF, or WOFF2 files; on Node.js and Bun, WOFF too. A font entry's `lang` is accepted but does not choose the font for a language; use the `lang` option or attribute for Chinese characters instead.

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

## Cache generated images

Each request renders the image again. A simple 1200 × 630 card takes around 10 ms of CPU time, one with gradients, bold text, or emoji 30 to 80 ms, and the first render in a new Worker instance more than 100 ms. [Workers Free allows 10 ms per request](../reference/config.md#worker) and fails requests from a Worker that keeps exceeding it, so on Workers Free, cache image routes with [revalidation](./edge/revalidation.md):

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

## Worker size

On Cloudflare, importing `void/og` adds Takumi's WebAssembly renderer to your Worker: about 4 MB, or 1.7 MB compressed. Cloudflare limits a Worker to 3 MB compressed on Workers Free and 10 MB on Workers Paid (see [Worker size](https://developers.cloudflare.com/workers/platform/limits/#worker-size)), so on Workers Free the rest of your app has about 1.3 MB. Apps that do not import `void/og` do not include the renderer.

## Node.js, Bun, and Deno

On the [Node.js, Bun, and Deno targets](../integrations/nodejs-bun-deno.md), add `takumi-js` to your app's `dependencies`, not `devDependencies`, so production installs include it:

```sh
npm install takumi-js@~2.18.2
```

If the build cannot find a version of `takumi-js` that Void supports, it fails and prints the command to install one.

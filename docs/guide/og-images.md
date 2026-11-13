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

JSX works in React apps. In Vue, Svelte, and Solid apps, use the `html` template tag from `void/html` instead, as shown in [Without React](#without-react). Elements also accept Tailwind classes in a `tw` prop, such as `<div tw="flex h-full w-full items-center justify-center bg-white">`.

### Without React

Use the [`html` template tag from `void/html`](../reference/api/html.md) instead of JSX. It escapes dynamic text automatically; plain strings are not accepted:

```ts
// routes/og/[slug].ts

import { defineHandler } from 'void';
import { html } from 'void/html';
import { OgImageResponse } from 'void/og';
import { getPost } from '../../src/posts';

export const GET = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  if (!post) {
    return c.notFound();
  }
  return new OgImageResponse(
    html`<div style="display: flex; width: 100%; height: 100%; padding: 80px; font-size: 72px">
      ${post.title}
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

## Image sizes

Set `preset` to choose a social preview size:

```ts
// routes/og/x.ts
import { html } from 'void/html';
import { OgImageResponse } from 'void/og';

export const GET = () =>
  new OgImageResponse(html`<div style="display: flex; font-size: 72px">Hello, world!</div>`, {
    preset: 'x',
  });
```

The `default` preset is 1200 × 630, the same size used when you omit sizing options. A preset determines both dimensions. For a custom size, set `width` and `height` without a preset:

```ts
import { html } from 'void/html';
import { OgImageResponse } from 'void/og';

export const GET = () =>
  new OgImageResponse(html`<div style="display: flex">Custom preview</div>`, {
    width: 1000,
    height: 500,
  });
```

Import `ogImageSizes` to read a preset's `[width, height]` tuple, or `OgImagePreset` to type a preset name:

```ts
import { ogImageSizes, type OgImagePreset } from 'void/og';

const preset: OgImagePreset = 'x-summary';
const [width, height] = ogImageSizes[preset]; // 600, 600
```

The presets combine published recommendations with general-purpose sizes where a service does not specify exact dimensions. They are not platform-enforced requirements, and clients may crop or resize images.

| Key         | Size        | Guidance                                                                                                                                                   |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facebook`  | 1200 × 630  | [Meta's recommended size](https://developers.facebook.com/docs/sharing/webmasters/images/).                                                                |
| `linkedin`  | 1200 × 627  | [LinkedIn's sharing-image minimum](https://www.linkedin.com/help/linkedin/answer/a521928).                                                                 |
| `discord`   | 1200 × 630  | Size used in [Discord's link-preview example](https://docs.discord.com/developers/link-previews/overview).                                                 |
| `bluesky`   | 1200 × 630  | Matches the [Bluesky client's card aspect ratio](https://github.com/bluesky-social/social-app/blob/main/src/lib/constants.ts).                             |
| `x`         | 1200 × 600  | 2:1 large-card preset; see this [Twitter Card sizing guide](https://renderscreenshot.com/blog/twitter-card-image-size).                                    |
| `x-summary` | 600 × 600   | Square summary-card preset; see the same sizing guide.                                                                                                     |
| `pinterest` | 1000 × 1500 | [Pinterest's recommended 2:3 Pin size](https://help.pinterest.com/en/business/article/pinterest-product-specs), rather than a landscape link-preview size. |
| `default`   | 1200 × 630  | General-purpose landscape preset for other social networks and chats.                                                                                      |

These presets describe rendering dimensions; they do not add page metadata. Point the page's `og:image` or `twitter:image` metadata at the generated image. For X, set `twitter:card` to `summary_large_image` with `x`, or `summary` with `x-summary`.

## Options

The optional second argument sets the image and the response:

| Option   | Default | Description                                                         |
| -------- | ------- | ------------------------------------------------------------------- |
| `preset` |         | An `OgImagePreset` name from the [image sizes](#image-sizes) table. |
| `width`  | `1200`  | Image width in pixels when no preset is set.                        |
| `height` | `630`   | Image height in pixels when no preset is set.                       |

See [Image Generation options](./image-generation.md#options) for all other options, response headers, and image-loading behavior.

## Caching

`OgImageResponse` allows browsers and shared caches to reuse an image for 24 hours by default:

```http
Cache-Control: public, max-age=86400
```

Updates at the same URL may take up to 24 hours to appear in caches that follow this policy. Social platforms may keep their own copies independently of this header. To publish a changed image without reusing the old image URL's cached copy, use a new URL, for example `/og/posts/hello-world/v2.png`, and update the page's `og:image` tag. Platforms still need to refresh the page metadata to discover the new URL. Deploying or purging Void's cache does not clear browser or social-platform caches.

Override the policy through `headers` if your images need a shorter or longer cache lifetime. For example, cache an image for one hour:

```ts
import { html } from 'void/html';
import { OgImageResponse } from 'void/og';

return new OgImageResponse(html`<div>${title}</div>`, {
  headers: { 'Cache-Control': 'public, max-age=3600' },
});
```

In `void dev`, generated image responses use `Cache-Control: no-store` so previews refresh as you edit. To avoid rendering every request that reaches your server, also [cache generated images at the edge](./image-generation.md#cache-generated-images).

## Learn More

Learn more in the [Image Generation](./image-generation.md) guide:

- [Fonts](./image-generation.md#fonts)
- [Control font downloads](./image-generation.md#control-font-downloads)
- [Cache generated images](./image-generation.md#cache-generated-images)
- [Worker size](./image-generation.md#worker-size)
- [Node.js, Bun, and Deno](./image-generation.md#node-js-bun-and-deno)

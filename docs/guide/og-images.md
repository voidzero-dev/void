---
outline: deep
---

# Open Graph Images

Use `OgImageResponse` from `void/image` to generate Open Graph and social preview images in a route handler. It extends [`ImageResponse`](./image-generation.md) with a default size of 1200 × 630 and a default public cache lifetime of 24 hours in production.

Void renders the image to PNG with Cloudflare Browser Run.

For other generated images, use `ImageResponse` from the same module.

## Setup

Configure the [`BROWSER` binding](./image-generation.md#setup) in `void.config.ts`.

For `.tsx` routes, follow the [Hono JSX setup](./image-generation.md#jsx-types).

## Usage

Return an `OgImageResponse` from a `.tsx` route using [Hono JSX](./image-generation.md#usage):

```tsx
// routes/og/[slug].tsx

import { defineHandler } from 'void';
import { OgImageResponse } from 'void/image';
import { ensurePost } from '../../src/posts';

export const GET = defineHandler(async (c) => {
  const post = await ensurePost(c.req.param('slug'));
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

In a `.ts` route, use [HTML templates](./image-generation.md#html-templates) instead.

## Await rendering

Use `renderOgImage(content, options?)` to await PNG bytes before creating a response. It defaults to 1200 × 630 and accepts the same dimensions and rendering options as `OgImageResponse`:

```ts
import { defineHandler } from 'void';
import { html } from 'void/html';
import { renderOgImage } from 'void/image';

export const GET = defineHandler(async (c) => {
  try {
    const png = await renderOgImage(html`<div style="display: flex">Built with Void</div>`);
    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return c.text('Image generation failed', 500);
  }
});
```

Unlike `OgImageResponse`, `renderOgImage` returns bytes, not an HTTP response, so it sets no headers or cache policy. Import `RenderOgImageOptions` for rendering options, or `OgImageResponseOptions` for rendering and response options.

`OgImageResponse` starts rendering only when its body is read. Await `renderOgImage` instead when rendering failures need to be caught before your route returns a response. See [Await rendering](./image-generation.md#await-rendering) for body consumption and cancellation behavior.

## Add the image to a page

Point an `og:image` tag at the route from your page's [`head()`](./pages-routing/head.md). Use an absolute image URL and include its dimensions, alt text, and the page's title, description, and URL:

```ts
// pages/posts/[slug].server.ts
import { defineHead } from 'void';

export interface Props {
  post: { title: string; slug: string; description: string };
}

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.post.title,
    meta: [
      { property: 'og:type', content: 'article' },
      { property: 'og:title', content: props.post.title },
      { property: 'og:description', content: props.post.description },
      { property: 'og:url', content: c.req.url },
      { property: 'og:image', content: new URL(`/og/${props.post.slug}`, c.req.url).href },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: props.post.title },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  };
});
```

## Image sizes

`OgImageResponse` and `renderOgImage` default to 1200 × 630, a general-purpose landscape size that follows Facebook's recommendation. The [Open Graph specification](https://ogp.me/#structured) does not require particular dimensions.

Set `width` and `height` for a different layout. For example, generate a 2:1 image for an X large-image card:

```ts
import { html } from 'void/html';
import { OgImageResponse } from 'void/image';

export const GET = () =>
  new OgImageResponse(html`<div style="display: flex">Hello, world!</div>`, {
    width: 1200,
    height: 600,
  });
```

Update the page's image URL and dimension tags to match. To use a separate image on X, set `twitter:image` to its absolute URL and add `twitter:image:alt`. Set `twitter:card` to `summary_large_image` for a landscape card or `summary` for a square thumbnail. X's [documented fallbacks](https://web.archive.org/web/20250101200326/https://developer.x.com/en/docs/x-for-websites/cards/overview/markup) use `og:image`, `og:title`, and `og:description` when their `twitter:` equivalents are absent.

### Platform guidance

Use the following first-party guidance when choosing dimensions and metadata. These are website link-preview specifications, not uploaded-photo or advertising specifications. Clients may crop or resize images.

| Platform and official documentation                                                                                                                          | Image metadata                                                                                                     | Dimensions and limits                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Facebook](https://developers.facebook.com/documentation/sharing/webmasters/images)                                                                          | `og:image`, `og:image:width`, `og:image:height`                                                                    | Recommended: at least **1200 × 630**, close to **1.91:1**. Minimum: **200 × 200**; at least **600 × 315** for a large preview. Maximum **8 MB**.                                    |
| [LinkedIn](https://www.linkedin.com/help/linkedin/answer/a521928)                                                                                            | `og:image`, plus `og:title`, `og:description`, `og:url`                                                            | Published sharing-module minimum: **1200 × 627**. Recommended ratio: **1.91:1**. Maximum **5 MB**.                                                                                  |
| [WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews)                                                          | `og:image`, plus `og:title`, `og:description`, `og:url`                                                            | At least **300 px wide**, with a width-to-height ratio of **4:1 or less**. Keep the image **under 600 KB**.                                                                         |
| [X large-image card](https://web.archive.org/web/20250118225525/https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image) | `twitter:image`, `twitter:card="summary_large_image"`                                                              | Documented ratio: **2:1**; **1200 × 600** matches it. Minimum **300 × 157**, maximum **4096 × 4096**; **under 5 MB**.                                                               |
| [X summary card](https://web.archive.org/web/20250107211007/https://developer.x.com/en/docs/x-for-websites/cards/overview/summary)                           | `twitter:image`, `twitter:card="summary"`                                                                          | **1:1**, cropped square. Minimum **144 × 144**, maximum **4096 × 4096**; **under 5 MB**.                                                                                            |
| [Discord](https://docs.discord.com/developers/link-previews/overview)                                                                                        | `og:image` or `twitter:image`; width, height, and alt tags; `twitter:card="summary_large_image"` for a large image | Official example: **1200 × 630**, not a required size. No pixel limits or required ratio specified.                                                                                 |
| [Slack](https://docs.slack.dev/messaging/unfurling-links-in-messages/#classic_unfurl)                                                                        | Open Graph or X/Twitter Card metadata                                                                              | No fixed dimensions or image file-size limit specified in the linked guide.                                                                                                         |
| [Bluesky](https://bsky.network/docs/about-bluesky-content/posts/#website-card-embeds)                                                                        | `og:image`, `og:title`, `og:description`                                                                           | No fixed dimensions specified for website cards.                                                                                                                                    |
| [Apple Messages](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages)                                               | `og:image`, `og:title`; `og:site_name` for branding                                                                | Recommended width: at least **900 px**. Images below **150 px wide** may become icons or be ignored. Associated images, icons, and videos have a **10 MB combined** resource limit. |
| [Pinterest Article Pins](https://developer.pinterest.com/docs/web-features/article-rich-pins/)                                                               | `og:image`; `og:type="article"` or `"blog"`, `og:title`, `og:description`                                          | Up to **six** high-resolution `og:image` URLs; no exact OG-image dimensions specified.                                                                                              |

The X links are archived official documentation; their former live URLs redirect to the developer homepage. Pinterest separately [recommends 1000 × 1500 (2:3) for Pin creative](https://help.pinterest.com/en/business/article/pinterest-product-specs), not as an OG-image requirement.

When sharing one image across services including WhatsApp, aim for **1200 × 630 under 600 KB**. Serve the metadata in the page's initial HTML and keep the image URL publicly accessible.

## Options

The optional second argument sets the image and the response:

| Option   | Default | Description             |
| -------- | ------- | ----------------------- |
| `width`  | `1200`  | Image width in pixels.  |
| `height` | `630`   | Image height in pixels. |

See [Image Generation options](./image-generation.md#options) for all other options, response headers, and image-loading behavior.

## Caching

In production, `OgImageResponse` allows browsers and shared caches to reuse an image for 24 hours by default:

```http
Cache-Control: public, max-age=86400
```

Updates at the same URL may take up to 24 hours to appear in caches that follow this policy. Social platforms may keep their own copies independently of this header. To publish a changed image without reusing the old image URL's cached copy, use a new URL, for example `/og/posts/hello-world/v2.png`, and update the page's `og:image` tag. Platforms still need to refresh the page metadata to discover the new URL. Deploying or purging Void's cache does not clear browser or social-platform caches.

Override the policy through `headers` if your images need a shorter or longer cache lifetime. For example, cache an image for one hour:

```ts
import { html } from 'void/html';
import { OgImageResponse } from 'void/image';

return new OgImageResponse(html`<div>${title}</div>`, {
  headers: { 'Cache-Control': 'public, max-age=3600' },
});
```

In development (`void dev` or a build with `NODE_ENV=development`), `OgImageResponse` adds no default `Cache-Control` header. You can still set your own, for example `Cache-Control: no-store` if you want previews to always fetch a fresh response. To avoid rendering every request that reaches your server in production, also [cache generated images at the edge](./image-generation.md#cache-generated-images).

## Learn More

Learn more in the [Image Generation](./image-generation.md) guide:

- [Fonts](./image-generation.md#fonts)
- [Cache generated images](./image-generation.md#cache-generated-images)
- [Takumi renderer](./image-generation.md#takumi-renderer)

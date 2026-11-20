---
outline: deep
---

# Image Generation

Use `ImageResponse` from `void/image` to generate PNGs for favicons, badges, and banners from your app's data.

By default, Void renders HTML and CSS with [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) or Chromium locally. You can also use [Takumi renderer](https://github.com/kane50613/takumi) that renders with a Wasm runtime.

For social previews, use [`OgImageResponse`](./og-images.md).

## Setup

In `void.config.ts`, add a Browser Run binding named `BROWSER`:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    browser: {
      binding: 'BROWSER',
      // To connect to Cloudflare Browser Run instead of local Chromium, set remote to true:
      // remote: true
    },
  },
});
```

For local development, `remote: true` (defaults to `false`) lets `void dev` use Browser Run in your Cloudflare account.

If you haven't connected the project yet, run `void connect --platform cloudflare`. Rendering uses your account's [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/).

### JSX Types

To make TypeScript recognize Hono JSX in your project, you have two options:

- **Per file:** If your app already uses another JSX runtime, keep its settings and add `/** @jsxImportSource void/jsx */` at the top of each `.tsx` file that uses Hono JSX.

- **Project-wide:** Add `void/jsx` to `compilerOptions.types` in `tsconfig.json`, keeping any existing entries. Set `jsxImportSource` as well: `types` loads the declarations but does not select the JSX runtime.

  ```json
  {
    "compilerOptions": {
      "jsx": "react-jsx",
      "jsxImportSource": "void/jsx",
      "types": ["void/jsx"]
    }
  }
  ```

  Match the import source in your [Vite JSX settings](./server-routing.md#jsx-handlers).

The examples below assume the project-wide setup.

## Usage

Return an `ImageResponse` from a `.tsx` route:

```tsx
// routes/favicon.png.tsx
import { defineHandler } from 'void';
import { ImageResponse } from 'void/image';

export const GET = defineHandler(() => {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        borderRadius: 12,
        background: '#0f172a',
        color: 'white',
        fontSize: 48,
        fontWeight: 700,
      }}
    >
      V
    </div>,
    { width: 64, height: 64 },
  );
});
```

`GET /favicon.png` returns a 64 × 64 PNG. Add a favicon link to your page's `<head>` (with [`head()`](./pages-routing/head.md) in Pages mode):

```html
<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />
```

### HTML templates

In a `.ts` route, use the [`html` template tag from `void/html`](../reference/api/html.md). It escapes interpolated text automatically:

```ts
// routes/badge.png.ts
import { defineHandler } from 'void';
import { html } from 'void/html';
import { ImageResponse } from 'void/image';

export const GET = defineHandler((c) => {
  const label = c.req.query('label') ?? 'Built with Void';
  return new ImageResponse(
    html`<div style="padding: 16px; background: #0f172a; color: white; font-size: 24px">
      ${label}
    </div>`,
    { width: 320, height: 64 },
  );
});
```

The image APIs accept Hono JSX and escaped HTML templates, including asynchronous templates without an extra `await`. Use `ImageInput` from `void/image` to type reusable content. Plain strings are not accepted.

### CSS and images

Use inline styles or a `<style>` block. JavaScript does not run in the screenshot page. Use public HTTPS URLs or data URLs for image assets. Keep the markup trusted: interpolate request text as text, and validate any request values used as asset URLs.

Chromium renders emoji with its system fonts. To use specific artwork, put an SVG or PNG in the markup with an `<img>` element.

## Await rendering

Use `renderImage(content, options)` for PNG bytes or to catch rendering failures before sending an HTTP response:

```ts
import { defineHandler } from 'void';
import { html } from 'void/html';
import { renderImage } from 'void/image';

export const GET = defineHandler(async (c) => {
  try {
    const png = await renderImage(html`<div>Built with Void</div>`, {
      width: 800,
      height: 400,
    });
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  } catch {
    return c.text('Image generation failed', 500);
  }
});
```

`renderImage` returns a `Promise<Uint8Array>` and sets no HTTP headers. For social previews with default dimensions, use [`renderOgImage`](./og-images.md#await-rendering).

`ImageResponse` and `OgImageResponse` start rendering when their body is read. Rendering failures reject body consumption. Cancelling an unread body prevents rendering; cancelling after rendering starts discards the result without interrupting the render.

## Options

Use `RenderImageOptions` for rendering options and `ImageResponseOptions` for rendering and HTTP response options. Both types are exported by `void/image`.

| Option                            | Default            | Description                                                        |
| --------------------------------- | ------------------ | ------------------------------------------------------------------ |
| `width`, `height`                 | Required           | Positive integer dimensions in pixels.                             |
| `font`                            | Roboto, sans-serif | A font family or an ordered list of families. See [Fonts](#fonts). |
| `fonts`                           |                    | Custom font faces.                                                 |
| `lang`                            |                    | Document language, such as `'ja'` or `'zh-TW'`.                    |
| `debug`                           | `false`            | Draws outlines around elements.                                    |
| `status`, `statusText`, `headers` |                    | HTTP options for `ImageResponse`.                                  |

`ImageResponse` sets `Content-Type: image/png` unless you override it.

## Fonts

Text uses Roboto by default. Use `font` to choose a [family installed in Browser Run](https://developers.cloudflare.com/browser-run/reference/supported-fonts/) or provide an ordered list. Chromium looks for each glyph in that order, then uses system fallback:

```ts
import { html } from 'void/html';
import { ImageResponse } from 'void/image';

export const GET = () =>
  new ImageResponse(html`<div>Hello, 世界</div>`, {
    width: 800,
    height: 400,
    lang: 'ja',
    font: ['Roboto', 'Noto Sans CJK JP', 'sans-serif'],
  });
```

For a custom font, add a named face to `fonts` and select its name in `font` or in your markup's CSS. `data` accepts an `ArrayBuffer`, a `Uint8Array`, or `{ url: string }` pointing to an HTTPS font file. If you use Google Fonts, pass the font file URL, not the stylesheet URL.

```ts
import { html } from 'void/html';
import { ImageResponse } from 'void/image';

export const GET = () =>
  new ImageResponse(html`<div>Built with Void</div>`, {
    width: 800,
    height: 400,
    fonts: [{ name: 'Brand', data: { url: 'https://example.com/fonts/brand.woff2' } }],
    font: ['Brand', 'Roboto'],
  });
```

Set `weight` (1–1000) for a single weight or omit it for a variable face. Set `style: 'italic'` to register an italic face.

## Cache generated images

Each request that reaches your handler renders a new image. To reuse renders at the edge, configure [revalidation](./edge/revalidation.md):

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: {
    revalidate: {
      '/favicon.png': 86400,
    },
  },
});
```

Add this setting to your existing `void.config.ts`. Void doesn't cache paths under `/api`. If query parameters affect the image, list them in [`routing.revalidateQueryAllowlist`](../reference/config.md#routing-revalidatequeryallowlist) or put those values in the path.

## Takumi renderer

[Takumi](https://takumi.kane.tw/docs/) renders images in your server runtime without a browser. It can run on Cloudflare Workers, Node.js, Bun, and Deno. Install it alongside `void`:

```sh
npm install @void/image-renderer-takumi
```

Pass `renderer: takumiRenderer` to `ImageResponse`, `OgImageResponse`, `renderImage`, or `renderOgImage`. Takumi does not require a `BROWSER` binding.

```ts
import { takumiRenderer } from '@void/image-renderer-takumi';
import { html } from 'void/html';
import { ImageResponse } from 'void/image';

export const GET = () =>
  new ImageResponse(html`<div style="display: flex; font-size: 48px">Built with Void</div>`, {
    width: 800,
    height: 400,
    renderer: takumiRenderer,
  });
```

### Takumi options

Pass `[takumiRenderer, options]` to configure Takumi. Shared options such as `width`, `height`, and `lang` stay outside the tuple:

```ts
import { takumiRenderer } from '@void/image-renderer-takumi';
import { html } from 'void/html';
import { ImageResponse } from 'void/image';

export const GET = () =>
  new ImageResponse(html`<div style="display: flex; font-size: 48px">こんにちは 👋</div>`, {
    width: 800,
    height: 400,
    lang: 'ja',
    renderer: [takumiRenderer, { emoji: 'twemoji', fallbackFonts: true }],
  });
```

| Option                | Default             | Description                                                                                    |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `fallbackFonts`       | `true`              | Downloads font subsets from Google Fonts for missing glyphs.                                   |
| `emoji`               | `'twemoji'`         | Emoji set: `'twemoji'`, `'blobmoji'`, `'noto'`, `'openmoji'`, `'fluent'`, or `'fluentFlat'`.   |
| `images.allowUrl`     | No custom filter    | A function that returns `false` to block a remote image or emoji URL.                          |
| `images.maxBytes`     | `33554432` (32 MiB) | Maximum response size in bytes per image download.                                             |
| `images.timeout`      | `30000` (30 s)      | Download timeout in milliseconds.                                                              |
| `images.throwOnError` | `true`              | Fails rendering when a non-emoji image fails to load. Set to `false` to omit the failed image. |

Use [CSS properties supported by Takumi](https://takumi.kane.tw/docs/styles). On Cloudflare, the renderer's WebAssembly and bundled font add to the Worker size, and rendering uses Worker CPU time. [Cache generated images](#cache-generated-images) if the same image is requested frequently.

Node.js and Bun builds include the renderer's WebAssembly file. Deploy the complete `dist` directory, including its assets.

### Takumi fonts

Roboto is bundled and selected by default. It covers Latin, Cyrillic, and Greek. Set `font: 'Geist'` to use the bundled Latin Geist face. Use `font` to select a custom family or an ordered list of families. Custom `fonts` entries take font bytes (`Uint8Array` or `ArrayBuffer`); load the file before passing it to the renderer. Keep reusable font bytes at module scope when practical.

Use WOFF2 instead of WOFF for custom fonts with `takumiRenderer`. WOFF is not supported by this renderer, including on Node.js. The default Browser Run renderer supports both formats.

Takumi can download font subsets from Google Fonts for glyphs such as Japanese, Chinese, Korean, Thai, Arabic, or Hebrew. Set `fallbackFonts: false` in the renderer tuple to skip those downloads. If no available font covers a glyph, it may render as a box. On Workers, downloads can add latency and count toward the [subrequest limit](https://developers.cloudflare.com/workers/platform/limits/#subrequests).

Use `lang` in the image options or on the root element to choose how Han characters are drawn, for example `'ja'`, `'zh-CN'`, `'zh-TW'`, or `'ko'`. Use one Han glyph style per render.

### Takumi emoji and remote images

Takumi downloads emoji artwork as part of rendering. Sets differ in coverage; for example, `noto` does not include country flags. Unavailable emoji are omitted, even when `images.throwOnError` is `true`.

Use `images.allowUrl` to allow only trusted sources when image URLs come from request data.

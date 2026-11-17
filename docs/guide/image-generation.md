---
outline: deep
---

# Image Generation

Use `ImageResponse` from `@void/image/generate` to generate PNG images from JSX or HTML in a route handler.

It renders with [Takumi](https://takumi.kane.tw/docs/), without a headless browser. Use it for favicons, badges, banners, and other images built from your app's data.

For Open Graph and social previews, use [`OgImageResponse`](./og-images.md) from the same module, which predefines standard Open Graph options, such as standard width and height.

## Setup

Install alongside `void`:

```sh
npm install @void/image
```

## Usage

Return an `ImageResponse` from a [`.tsx` route](./server-routing.md#jsx-handlers), passing the required `width` and `height` in pixels:

```tsx
// routes/favicon.png.tsx

import { ImageResponse } from '@void/image/generate';
import { defineHandler } from 'void';

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

`GET /favicon.png` now returns a 64 × 64 PNG. Add a favicon link to your page's `<head>` (with [`head()`](./pages-routing/head.md) in Pages mode):

```html
<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png" />
```

JSX works in React apps. In Vue, Svelte, and Solid apps, use the `html` template tag from `void/html` instead, as shown below.

JSX elements also accept Tailwind classes in a `tw` prop, such as `<div tw="flex h-full w-full items-center justify-center bg-white">`.

### React JSX types

For TypeScript support for `tw`, CSS custom properties such as `--accent`, and `textFit` in React JSX, add `@void/image/react` to `compilerOptions.types` in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["vite/client", "@void/image/react"]
  }
}
```

Keep any existing entries in `types`. This enables the additional React typings across your project.

Alternatively, add a type-only import to a source file included by your `tsconfig.json`:

```ts
import type {} from '@void/image/react';
```

Both approaches affect only TypeScript; neither adds runtime code. Ordinary JSX with standard CSS properties needs no opt-in. HTML templates and `ImageNode` trees also need no React typings.

### Without React

Use the [`html` template tag from `void/html`](../reference/api/html.md) instead of JSX. It escapes dynamic text automatically (plain strings are not accepted):

```ts
// routes/favicon.png.ts

import { ImageResponse } from '@void/image/generate';
import { defineHandler } from 'void';
import { html } from 'void/html';

export const GET = defineHandler(() => {
  return new ImageResponse(
    html`<div
      style="display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: 12px; font-size: 48px; font-weight: 700; background: #0f172a; color: white"
    >
      V
    </div>`,
    { width: 64, height: 64 },
  );
});
```

Both `ImageResponse` and `OgImageResponse` accept nested and asynchronous `html` templates without an extra `await`. Import `ImageInput` from `@void/image/generate` to type reusable image content.

### Image node trees

You can also build images with typed objects, without JSX or HTML:

```ts
import { ImageResponse, type ImageNode, type ImageStyle } from '@void/image/generate';
import { defineHandler } from 'void';

const style: ImageStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: '#0f172a',
  color: 'white',
  fontSize: 48,
};

const content: ImageNode = {
  type: 'container',
  style,
  children: [{ type: 'text', text: 'Built with Void' }],
};

export const GET = defineHandler(() => new ImageResponse(content, { width: 800, height: 400 }));
```

An `ImageNode` is a `container` with optional `children`, a `text` node with a `text` string, or an `image` node with a `src`. Image sources can be URLs, data URLs, encoded image bytes (`Uint8Array` or `ArrayBuffer`), or raw pixels described by `ImageRgbaData`.

Import `ImageJsxElement` to type reusable JSX elements and `ImageFont` to type custom font entries. All these types are available from `@void/image/generate`.

## Options

The second argument is required and sets the image and the response. Import `RenderImageOptions` for rendering options or `ImageResponseOptions` for rendering and response options from `@void/image/generate`.

| Option                            | Default     | Description                                                                                                                                  |
| --------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `width`                           | Required    | Image width in pixels.                                                                                                                       |
| `height`                          | Required    | Image height in pixels.                                                                                                                      |
| `defaultFont`                     | `'Inter'`   | Bundled font: `'Inter'` or `'Geist'`. Neither needs a download. See [Fonts](#fonts).                                                         |
| `fonts`                           |             | Custom fonts to use before the default font. See [Fonts](#fonts).                                                                            |
| `fallbackFonts`                   | `true`      | Set to `false` to download no fonts from Google Fonts. See [Control font downloads](#control-font-downloads).                                |
| `emoji`                           | `'twemoji'` | Emoji style: `twemoji`, `blobmoji`, `noto`, `openmoji`, `fluent`, or `fluentFlat`.                                                           |
| `lang`                            |             | Language of the text, such as `'ja'` or `'zh-TW'`, for Chinese characters.                                                                   |
| `debug`                           | `false`     | Draws a border around every box.                                                                                                             |
| `images`                          |             | Limits for remote images and emoji: `allowUrl`, `maxBytes`, `timeout`, and `throwOnError`. Set them when the markup includes request values. |
| `status`, `statusText`, `headers` |             | The response status and headers.                                                                                                             |

Responses have this header unless you set it in `headers`:

```http
Content-Type: image/png
```

`ImageResponse` does not set `Cache-Control`. Set your own policy through `headers`, or [cache generated images at the edge](#cache-generated-images). In `void dev`, generated image responses use `Cache-Control: no-store` so previews refresh as you edit.

Emoji and remote images are downloaded while the image renders. An emoji that the chosen style does not have, or an image that fails to download, fails the image unless you pass `images: { throwOnError: false }`, which leaves it out; `noto` has no flags.

## Fonts

Text uses bundled Inter by default. It supports Latin, extended Latin, Cyrillic, and Greek, including letters like Ł and ş and symbols like → and ★, without downloading fonts. Its variable weights range from 100 to 900.

To use bundled Geist instead, set `defaultFont: 'Geist'`. No font URL, file, or download is needed:

```ts
import { ImageResponse } from '@void/image/generate';
import { html } from 'void/html';

return new ImageResponse(html`<div style="display: flex">Built with Void</div>`, {
  width: 800,
  height: 400,
  defaultFont: 'Geist',
});
```

The bundled Geist is a Latin subset with variable weights from 300 to 800. Unlike Inter, it needs fallback downloads for Cyrillic, Greek, extended Latin letters such as Ł and ş, and symbols such as → and ★.

Your custom `fonts` take priority over the selected default font, which draws characters they lack.

When the text includes characters the default font cannot draw, such as Japanese, Chinese, Korean, Thai, Arabic, or Hebrew, Void downloads a matching [Noto](https://fonts.google.com/noto) font from Google Fonts while rendering, such as Noto Sans JP for Japanese. With `defaultFont: 'Geist'`, its additional Cyrillic and Latin letters come from Geist's own Google Fonts subsets. Void asks for only the characters the image uses, whether or not `fonts` covers them. If neither the supplied fonts nor a downloaded font can draw a character, it appears as a box.

Chinese characters are drawn in the Japanese style unless the `lang` option or the root element's `lang` attribute names the language, or the text has Korean around them. A `lang` wins over the text:

```ts
import { ImageResponse } from '@void/image/generate';
import { html } from 'void/html';

return new ImageResponse(html`<div lang="zh-TW" style="display: flex">台灣咖啡</div>`, {
  width: 800,
  height: 400,
});
```

One style applies to all Chinese characters in an image, so an image cannot mix Japanese and Chinese styles through `lang` on inner elements.

To use your own fonts, pass `fonts`. An entry is either a font URL or an object with the font's data:

```ts
import { ImageResponse } from '@void/image/generate';
import { html } from 'void/html';

return new ImageResponse(html`<div style="display: flex">Built with Void</div>`, {
  width: 800,
  height: 400,
  fonts: [
    'https://example.com/fonts/brand-variable.woff2',
    { name: 'Brand', data: brandRegular, weight: 400, style: 'normal' },
  ],
});
```

A `weight` from 1 to 1000 makes the font draw only that weight. Leave it out for a variable font, so each element's `fontWeight` sets the weight, including values between the usual steps such as `550`.

Fonts can be TTF, OTF, or WOFF2 files; on Node.js and Bun, WOFF too. A font entry's `lang` is accepted but does not choose the font for a language; use the `lang` option or attribute for Chinese characters instead.

### Control font downloads

Void keeps a bounded in-memory font cache on every target. Images with new text outside the default font's coverage download a small font made for that text, such as a 26 KB file for a Japanese title. Evicted fonts download again when needed. On Cloudflare Workers, these downloads count toward the [subrequest limit](https://developers.cloudflare.com/workers/platform/limits/#subrequests) and add latency to rendering.

To decide which fonts load and when, pass the fonts your images need in `fonts` and set `fallbackFonts: false`. Void then downloads no fallback fonts, and characters that neither your fonts nor the selected default font can draw are drawn as boxes:

```ts
import { ImageResponse } from '@void/image/generate';
import { html } from 'void/html';

return new ImageResponse(html`<div style="display: flex">こんにちは</div>`, {
  width: 800,
  height: 400,
  fonts: [{ name: 'Noto Sans JP', data: notoSansJp }],
  fallbackFonts: false,
});
```

A font passed as data can be reused across images without downloading it. Keep its data at module scope to avoid reading the file for every request.

## Cache generated images

Each request renders the image again. Rendering uses CPU time, especially with fonts, gradients, or emoji, and the first render in a new Worker instance can take more than 100 ms. [Workers Free allows 10 ms per request](../reference/config.md#worker) and fails requests from a Worker that keeps exceeding it, so on Workers Free, cache image routes with [revalidation](./edge/revalidation.md):

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: {
    revalidate: {
      '/favicon.png': 86400,
    },
  },
});
```

Void never caches paths under `/api`, so serve images from another path, such as `/favicon.png`. The cache ignores query strings, so put values in the path, or list the query parameters in [`routing.revalidateQueryAllowlist`](../reference/config.md#routing-revalidatequeryallowlist).

## Worker size

On Cloudflare, importing `@void/image/generate` adds Takumi's WebAssembly renderer and bundled Inter to your Worker. A larger Worker takes longer to upload on each deploy and to start in a new instance. Apps that do not import this module include neither the renderer nor Inter.

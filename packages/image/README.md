# @void/image

Image generation for [Void](https://void.cloud). Build PNG images and Open Graph previews from JSX, HTML templates, or image node trees without a headless browser.

## Setup

Install alongside `void`:

```sh
npm install @void/image
```

Return an image from a route handler:

```ts
import { OgImageResponse } from '@void/image/generate';
import { defineHandler } from 'void';
import { html } from 'void/html';

export const GET = defineHandler(
  () =>
    new OgImageResponse(html`<div style="display: flex; font-size: 72px">Built with Void</div>`),
);
```

Use `ImageResponse` from the same module for images with explicit `width` and `height`. Both classes use Takumi's WebAssembly renderer.

For React JSX with `tw`, CSS custom properties, or `textFit`, append `@void/image/react` to
`compilerOptions.types` in `tsconfig.json`. Alternatively, add
`import type {} from '@void/image/react'` to an included source file. See
[React JSX types](https://void.cloud/guide/image-generation#react-jsx-types) for examples.

## Documentation

See [Image Generation](https://void.cloud/guide/image-generation) for fonts, emoji, and rendering options, and [Open Graph Images](https://void.cloud/guide/og-images) for social preview sizes and caching.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.

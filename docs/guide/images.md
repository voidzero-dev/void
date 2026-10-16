---
outline: deep
---

# Images

`Image` renders an `<img>` that loads lazily, reserves its space while it loads, and picks a size that suits the screen from a responsive `srcset`. Void resizes the image and converts it to a modern format at `/_void/image`, using [Cloudflare Images](https://developers.cloudflare.com/images/transform-images/bindings/).

`Image`, `getImageProps()`, loaders, and the `images` config match `next/image` in Next.js 16. Code written for `next/image` works in Void with the changes listed in [Migrating from `next/image`](#migrating-from-next-image).

## Rendering an Image

Each Pages adapter exports `Image`:

::: code-group

```tsx [React]
// pages/team.tsx
import { Image } from '@void/react';

export default function Team() {
  return <Image src="/avatars/ada.png" alt="Ada Lovelace" width={64} height={64} />;
}
```

```vue [Vue]
<!-- pages/team.vue -->
<script setup lang="ts">
import { Image } from '@void/vue';
</script>

<template>
  <Image src="/avatars/ada.png" alt="Ada Lovelace" :width="64" :height="64" />
</template>
```

```svelte [Svelte]
<!-- pages/team.svelte -->
<script lang="ts">
import { Image } from '@void/svelte';
</script>

<Image src="/avatars/ada.png" alt="Ada Lovelace" width={64} height={64} />
```

```tsx [Solid]
// pages/team.tsx
import { Image } from '@void/solid';

export default function Team() {
  return <Image src="/avatars/ada.png" alt="Ada Lovelace" width={64} height={64} />;
}
```

:::

The page renders this element, shown here formatted for readability:

```html
<img
  alt="Ada Lovelace"
  loading="lazy"
  width="64"
  height="64"
  decoding="async"
  data-nimg="1"
  style="color:transparent"
  srcset="
    /_void/image?url=%2Favatars%2Fada.png&w=64&q=75  1x,
    /_void/image?url=%2Favatars%2Fada.png&w=128&q=75 2x
  "
  src="/_void/image?url=%2Favatars%2Fada.png&w=128&q=75"
/>
```

`width` and `height` set the intrinsic size in pixels and reserve the image's space, so the layout doesn't shift when it loads. Style the displayed size with CSS as usual.

### Props

| Prop                | Default  | Description                                                                                                                                       |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`               | Required | A path such as `/hero.jpg`, an absolute URL allowed by [`remotePatterns`](#remote-images), or a [static import](#imported-files).                 |
| `alt`               | Required | Text alternative. Use `""` for decorative images.                                                                                                 |
| `width`, `height`   | —        | Intrinsic size in pixels. Required unless `src` is a static import or `fill` is set.                                                              |
| `fill`              | `false`  | Fill the parent element instead of using `width` and `height`. See [Filling a container](#filling-a-container).                                   |
| `sizes`             | —        | Media conditions for the displayed width, such as `(max-width: 768px) 100vw, 50vw`. See [Responsive images](#responsive-images).                  |
| `quality`           | `75`     | Quality from 1 to 100. Void uses the closest value in [`images.qualities`](../reference/config.md#images).                                        |
| `preload`           | `false`  | Load the image early. See [Preloading](#preloading). `priority` is a deprecated alias.                                                            |
| `loading`           | `lazy`   | `lazy` or `eager`.                                                                                                                                |
| `fetchPriority`     | —        | `high`, `low`, or `auto`.                                                                                                                         |
| `decoding`          | `async`  | `async`, `sync`, or `auto`.                                                                                                                       |
| `placeholder`       | `empty`  | `empty`, `blur`, or a `data:image/...` URL. See [Placeholders](#placeholders).                                                                    |
| `blurDataURL`       | —        | Small data URL shown blurred while the image loads, with `placeholder="blur"`.                                                                    |
| `loader`            | —        | Function that builds image URLs. See [Loaders](#loaders).                                                                                         |
| `unoptimized`       | `false`  | Serve `src` as is, without a `srcset`.                                                                                                            |
| `overrideSrc`       | —        | Use this value as the `src` attribute while keeping the generated `srcset`.                                                                       |
| `onLoad`, `onError` | —        | Run after the image loads or fails to load. Vue uses `@load` and `@error`; Svelte uses `onload` and `onerror`. `onLoadingComplete` is deprecated. |

Other attributes, such as `class`, `style`, `id`, `title`, and `crossOrigin`, pass through to the `<img>`. Vue, Svelte, and Solid accept `class` and `style` in their usual forms, including style strings.

Images without a `width` and `height`, or with invalid prop combinations, throw an error during development that explains the fix.

## Sizing

### Fixed size

With `width` and `height` only, the `srcset` offers the image at 1x and 2x density. The browser picks one for the screen's pixel density.

### Responsive images

Add `sizes` when the displayed width depends on the viewport. The `srcset` then lists widths from [`images.deviceSizes` and `images.imageSizes`](../reference/config.md#images), and the browser downloads the smallest one that covers the displayed size:

```tsx
<Image
  src="/blog/cover.jpg"
  alt="Cover"
  width={1200}
  height={630}
  sizes="(max-width: 768px) 100vw, 50vw"
  style={{ width: '100%', height: 'auto' }}
/>
```

### Filling a container

Set `fill` when the image's size comes from its parent, such as a banner of unknown aspect ratio. The image is absolutely positioned to cover the parent, so the parent needs `position: relative`, `absolute`, or `fixed`. `sizes` defaults to `100vw`; set it when the container is narrower than the viewport.

::: code-group

```tsx [React]
<div style={{ position: 'relative', height: 400 }}>
  <Image
    src="/hero.jpg"
    alt="Mountains at dawn"
    fill
    sizes="100vw"
    style={{ objectFit: 'cover' }}
  />
</div>
```

```vue [Vue]
<div style="position: relative; height: 400px">
  <Image src="/hero.jpg" alt="Mountains at dawn" fill sizes="100vw" style="object-fit: cover" />
</div>
```

```svelte [Svelte]
<div style="position: relative; height: 400px">
  <Image src="/hero.jpg" alt="Mountains at dawn" fill sizes="100vw" style="object-fit: cover" />
</div>
```

```tsx [Solid]
<div style={{ position: 'relative', height: '400px' }}>
  <Image
    src="/hero.jpg"
    alt="Mountains at dawn"
    fill
    sizes="100vw"
    style={{ 'object-fit': 'cover' }}
  />
</div>
```

:::

## Loading Behavior

Images load lazily (`loading="lazy"`) and decode asynchronously (`decoding="async"`) by default, so offscreen images don't compete with the content the visitor sees first. The `<img>` style includes `color: transparent`, which hides the alt text while the image loads.

### Preloading

Set `preload` on the image that is likely to be the [Largest Contentful Paint](https://web.dev/articles/lcp), such as a hero image above the fold. It loads the image eagerly and adds a `<link rel="preload" as="image">` to the server-rendered page:

```tsx
<Image src="/hero.jpg" alt="Mountains at dawn" width={1600} height={900} preload />
```

Use `preload` for one or two images per page. To load an image early without a preload link, set `loading="eager"` or `fetchPriority="high"` instead. `priority` still works as a deprecated alias of `preload`; don't combine it with `preload` or `loading="lazy"`.

#### Custom SSR

Pages Routing adds the preload link with every adapter. In a [custom SSR](./ssr.md) app, your server entry writes `<head>`, so it has to include the link:

- **React**: `renderToString` includes the link in the HTML it returns. No setup is needed.
- **Vue**: pass an SSR context object to `renderToString` and insert `ssrContext.__voidImagePreloads?.render()` in `<head>`.
- **Svelte**: insert the `head` that `render()` returns in `<head>`.
- **Solid**: provide a collector from `createImagePreloadCollector()` through `ImagePreloadContext`, and insert its `render()` output in `<head>`. Wrap the client tree in the same provider with `null`, so hydration matches the server.

::: code-group

```ts [Vue]
// src/main.ssr.ts
const ssrContext: SSRContext = {};
const appHtml = await renderToString(createSSRApp(App), ssrContext);
const imagePreloads = ssrContext.__voidImagePreloads?.render() ?? '';
// Insert imagePreloads in <head>.
```

```ts [Svelte]
// src/main.ssr.ts
const { head, body: appHtml } = render(App);
// Insert head in <head>.
```

```tsx [Solid]
// src/main.ssr.tsx
import { ImagePreloadContext } from '@void/solid';
import { createImagePreloadCollector } from 'void/image';

const imagePreloads = createImagePreloadCollector();
const appHtml = renderToString(() => (
  <ImagePreloadContext.Provider value={imagePreloads}>
    <App />
  </ImagePreloadContext.Provider>
));
// Insert imagePreloads.render() in <head>.

// src/main.client.tsx
hydrate(
  () => (
    <ImagePreloadContext.Provider value={null}>
      <App />
    </ImagePreloadContext.Provider>
  ),
  document.getElementById('app')!,
);
```

:::

The React, Vue, and Svelte entries that [`void gen ssr`](../reference/cli/generate.md#void-gen-ssr) creates already do this.

### Placeholders

A placeholder fills the image's space until the image loads:

- `placeholder="blur"` shows `blurDataURL` blurred. Void doesn't generate `blurDataURL`, so pass a small data URL yourself, for example one produced when you upload the image.
- `placeholder="data:image/..."` shows that data URL as is, for example a solid color or a small SVG.
- `placeholder="empty"`, the default, shows nothing.

```tsx
<Image
  src="/photos/lake.jpg"
  alt="Lake"
  width={800}
  height={533}
  placeholder="blur"
  blurDataURL="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
/>
```

The placeholder is removed once the image loads. Images smaller than 40×40 pixels don't benefit from a placeholder.

## Local Images

### Files in `public/`

Reference files in [`public/`](../reference/structure.md#public) by their root path, with `width` and `height`:

```tsx
<Image src="/photos/lake.jpg" alt="Lake" width={800} height={533} />
```

Void requests a local image through your app, as a visitor without cookies would, so [middleware](#optimization-endpoint) that guards its path applies. When a route or page answers the path, its response is the image.

A local `src` with a query string, such as `/photo.jpg?v=2`, is rejected unless [`images.localPatterns`](#allowed-sources) allows it.

### Imported files

Import an image with the `?image` query to get its URL and intrinsic size, read from the file at build time:

::: code-group

```tsx [React]
import { Image } from '@void/react';
import hero from './hero.jpg?image';

export default function Home() {
  return <Image src={hero} alt="Mountains at dawn" preload />;
}
```

```vue [Vue]
<script setup lang="ts">
import { Image } from '@void/vue';
import hero from './hero.jpg?image';
</script>

<template>
  <Image :src="hero" alt="Mountains at dawn" preload />
</template>
```

```svelte [Svelte]
<script lang="ts">
import { Image } from '@void/svelte';
import hero from './hero.jpg?image';
</script>

<Image src={hero} alt="Mountains at dawn" preload />
```

```tsx [Solid]
import { Image } from '@void/solid';
import hero from './hero.jpg?image';

export default function Home() {
  return <Image src={hero} alt="Mountains at dawn" preload />;
}
```

:::

The import is a `StaticImageData` object, `{ src, width, height }`. `Image` takes `width` and `height` from it; pass one of them to scale the other proportionally. Supported files are PNG, JPEG, GIF, WebP, AVIF, HEIC, SVG, BMP, and ICO.

Imported images get a content hash in their file name, so optimized versions are cached with `Cache-Control: public, max-age=315360000, immutable`. An import without `?image` keeps Vite's default behavior and returns the URL string. Vite inlines very small files as data URLs, and `Image` serves those as is.

## Remote Images

Allow each remote source in [`images.remotePatterns`](../reference/config.md#images). Then pass the absolute URL with `width` and `height`:

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  images: {
    remotePatterns: [
      new URL('https://images.example.com/photos/**'),
      { protocol: 'https', hostname: '**.cdn.example.com', pathname: '/avatars/**' },
    ],
  },
});
```

```tsx
<Image src="https://images.example.com/photos/lake.jpg" alt="Lake" width={800} height={533} />
```

### Allowed sources

`/_void/image` fetches only sources that match your patterns:

- **`remotePatterns`** lists allowed remote sources. A pattern matches `protocol`, `hostname`, `port`, `pathname`, and `search`; omitted fields match anything. In `pathname`, `*` matches one path segment and `**` matches any number. In `hostname`, `*.example.com` and `**.example.com` both match any subdomain of `example.com`, but not `example.com` itself. A `URL` object is shorthand for a pattern with its protocol, hostname, port, and path, and matches only URLs without a query string. No remote source is allowed by default.
- **`localPatterns`** limits local sources. By default, any local path without a query string is allowed. When you set it, list every allowed `pathname` and `search`; static `?image` imports stay allowed.

```ts
images: {
  localPatterns: [{ pathname: '/photos/**', search: '' }],
},
```

During development, an `Image` whose `src` doesn't match these patterns throws an error that names the setting to change.

Remote sources must use `http` or `https`. Void follows up to `images.maximumRedirects` redirects whose targets also match `remotePatterns`, and stops after 7 seconds. Unless `images.dangerouslyAllowLocalIP` is set, it refuses URLs whose host is `localhost` or a private or loopback IP address. Hostnames aren't resolved first, so allow only hosts you trust in `remotePatterns`.

## `getImageProps`

`getImageProps(props)` returns the attributes `Image` would render, without rendering anything. Use it for `<picture>` elements, background images, or markup that `Image` doesn't cover. It accepts the same props as `Image` and returns `{ props }`.

### Art direction

Serve a different image per breakpoint with `<picture>`:

::: code-group

```tsx [React]
import { getImageProps } from '@void/react';

export default function Hero() {
  const common = { alt: 'Mountains at dawn', sizes: '100vw' };
  const {
    props: { srcSet: desktop },
  } = getImageProps({ ...common, src: '/hero-desktop.jpg', width: 1440, height: 875 });
  const {
    props: { srcSet: mobile, ...rest },
  } = getImageProps({ ...common, src: '/hero-mobile.jpg', width: 750, height: 1334 });

  return (
    <picture>
      <source media="(min-width: 1000px)" srcSet={desktop} />
      <source media="(min-width: 500px)" srcSet={mobile} />
      <img {...rest} style={{ width: '100%', height: 'auto' }} />
    </picture>
  );
}
```

```vue [Vue]
<script setup lang="ts">
import { getImageProps } from '@void/vue';

const common = { alt: 'Mountains at dawn', sizes: '100vw' };
const {
  props: { srcset: desktop },
} = getImageProps({ ...common, src: '/hero-desktop.jpg', width: 1440, height: 875 });
const {
  props: { srcset: mobile, ...rest },
} = getImageProps({ ...common, src: '/hero-mobile.jpg', width: 750, height: 1334 });
</script>

<template>
  <picture>
    <source media="(min-width: 1000px)" :srcset="desktop" />
    <source media="(min-width: 500px)" :srcset="mobile" />
    <img v-bind="rest" />
  </picture>
</template>
```

```svelte [Svelte]
<script lang="ts">
import { getImageProps } from '@void/svelte';

const common = { alt: 'Mountains at dawn', sizes: '100vw' };
const {
  props: { srcset: desktop },
} = getImageProps({ ...common, src: '/hero-desktop.jpg', width: 1440, height: 875 });
const {
  props: { srcset: mobile, ...rest },
} = getImageProps({ ...common, src: '/hero-mobile.jpg', width: 750, height: 1334 });
</script>

<picture>
  <source media="(min-width: 1000px)" srcset={desktop} />
  <source media="(min-width: 500px)" srcset={mobile} />
  <img {...rest} />
</picture>
```

```tsx [Solid]
import { getImageProps } from '@void/solid';

export default function Hero() {
  const common = { alt: 'Mountains at dawn', sizes: '100vw' };
  const {
    props: { srcset: desktop },
  } = getImageProps({ ...common, src: '/hero-desktop.jpg', width: 1440, height: 875 });
  const {
    props: { srcset: mobile, ...rest },
  } = getImageProps({ ...common, src: '/hero-mobile.jpg', width: 750, height: 1334 });

  return (
    <picture>
      <source media="(min-width: 1000px)" srcset={desktop} />
      <source media="(min-width: 500px)" srcset={mobile} />
      <img {...rest} />
    </picture>
  );
}
```

:::

React's `getImageProps` returns React attribute names such as `srcSet` and a style object. The Vue, Svelte, and Solid versions return HTML attribute names, such as `srcset`, `class`, and `fetchpriority`, with `style` as a string, ready to bind to an element. Keys without a value are left out.

`void/image` also exports a framework-neutral `getImageProps` that returns React attribute names. Use it in server code or outside a Pages adapter, for example to build an `image-set()` background.

`getImageProps` doesn't add a preload link, even with `preload`. Avoid `placeholder` with it, because nothing removes the placeholder after the image loads.

## Loaders

A loader turns `src`, `width`, and `quality` into an image URL. The default loader builds `/_void/image` URLs. Any loader is a function with this signature:

```ts
import type { ImageLoaderProps } from 'void/image';

type ImageLoader = (props: ImageLoaderProps) => string;
// ImageLoaderProps: { src: string; width: number; quality?: number }
```

`Image` calls the loader once for each width in the `srcset`. Use `width` in the URL; a loader that ignores it serves the same file at every size, and Void warns about it during development.

### `loader` prop

Pass a loader to a single image:

```tsx
import { Image, type ImageLoaderProps } from '@void/react';

function imageServiceLoader({ src, width, quality }: ImageLoaderProps) {
  return `https://images.example.com${src}?w=${width}&q=${quality ?? 75}`;
}

<Image loader={imageServiceLoader} src="/photos/lake.jpg" alt="Lake" width={800} height={533} />;
```

The prop works the same way in every adapter.

### Loader file

To use a loader for every `Image`, export it as the default export of a module and set `images.loaderFile`. The path is relative to the project root:

```ts
// image-loader.ts
import type { ImageLoaderProps } from 'void/image';

export default function imageServiceLoader({ src, width, quality }: ImageLoaderProps): string {
  const url = new URL(src, 'https://images.example.com');
  url.searchParams.set('w', String(width));
  url.searchParams.set('q', String(quality ?? 75));
  return url.href;
}
```

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  images: {
    loader: 'custom',
    loaderFile: './image-loader.ts',
  },
});
```

The loader runs on the server and in the browser. With `loader: 'custom'` and no `loaderFile`, every `Image` must pass a `loader` prop.

### Cloudflare zone transformations

If your app is served from a domain in a Cloudflare zone with [image transformations](https://developers.cloudflare.com/images/transform-images/) enabled, the `cloudflare` loader builds transformation URLs that the zone serves directly:

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  images: { loader: 'cloudflare' },
});
```

An image with `src="/hero.jpg"` then gets URLs such as `/cdn-cgi/image/width=640,quality=75,format=auto/hero.jpg`. Cloudflare picks the output format for each browser. Set `images.path` to use another zone, such as `https://images.example.com/cdn-cgi/image`.

The `cloudflare` loader needs no Images binding and doesn't use `/_void/image`. During development it returns the original `src`, because zone transformations only exist on Cloudflare's network. Transformations count toward the same [Cloudflare Images allowance](#free-allowance).

### Unoptimized images

Set `unoptimized` on an image, or `images.unoptimized: true` for every image, to serve `src` as is without a `srcset`. `data:` and `blob:` URLs are always served as is. With the default and `cloudflare` loaders, SVG files are too, unless `images.dangerouslyAllowSVG` is set.

## Optimization Endpoint

With the default loader, `Image` points at `/_void/image`:

```
GET /_void/image?url=%2Fphotos%2Flake.jpg&w=828&q=75
```

| Parameter | Value                                                                             |
| --------- | --------------------------------------------------------------------------------- |
| `url`     | A local path starting with `/`, or an absolute `http` or `https` URL, URL-encoded |
| `w`       | Output width. Must be one of `images.deviceSizes` or `images.imageSizes`          |
| `q`       | Output quality. Must be one of `images.qualities`                                 |

A request with a missing or disallowed parameter returns `400` with a plain-text reason, such as `"w" parameter (width) of 500 is not allowed` or `"url" parameter is not allowed`. A source that isn't an image also returns `400`. Sources larger than `images.maximumResponseBody` return `413`, remote sources that time out return `504`, and more than `images.maximumRedirects` redirects return `508`. An error status from the source, such as `404`, is passed through. `/_void/image` answers `GET` and `HEAD` requests; other methods return `405`.

The endpoint runs after your middleware, so middleware that guards every path also applies to image requests. It then requests a local source through your middleware and routes without the visitor's cookies or headers, as Next.js does. If middleware refuses that request, for example because the source path requires a session, the image fails with that status even for signed-in visitors. Let anonymous requests for image paths through, or render those images with `unoptimized`.

### Output formats

The endpoint picks the first type in [`images.formats`](../reference/config.md#images) that the request's `Accept` header lists explicitly. The default is `['image/webp']`. To prefer AVIF:

```ts
images: {
  formats: ['image/avif', 'image/webp'],
},
```

AVIF output is limited to 1,200 pixels wide, so wider images use the next listed format. When the browser accepts none of the formats, the response keeps the source format, except that WebP and AVIF sources are converted to JPEG. Images are only scaled down, never enlarged.

### Caching

Optimized images are cached in the Cloudflare data center that served them. Responses include:

- `Cache-Control: public, max-age=<seconds>, must-revalidate`, where `<seconds>` is the larger of `images.minimumCacheTTL` (default four hours) and the source's own `max-age`. [Imported files](#imported-files) use `public, max-age=315360000, immutable`.
- `ETag`, and `304 Not Modified` for a matching `If-None-Match`.
- `Vary: Accept`.
- `X-Void-Image-Cache: HIT` or `MISS`.
- `Content-Disposition` (`attachment` by default; see `images.contentDispositionType`), `Content-Security-Policy` from `images.contentSecurityPolicy`, and `X-Content-Type-Options: nosniff`.

Cached local images belong to the deployment that served them, so a new deployment optimizes them again. Cached remote images stay until their cache time expires.

### Images served unchanged

Some sources are returned exactly as stored:

- Animated GIF, PNG, and WebP files.
- SVG files, which are rejected unless `images.dangerouslyAllowSVG` is `true`. Keep the default `contentSecurityPolicy` when you allow SVG.
- ICO, BMP, HEIC, and JPEG XL files.
- GIF, TIFF, and JPEG 2000 files when the browser accepts none of the configured formats.

If a transformation fails, including when the [Free allowance](#free-allowance) is used up, the endpoint serves the original file with `images.minimumCacheTTL` as its cache time and logs a warning.

## Development

Images are optimized during development without a Cloudflare connection. Local transformations apply the requested width and output format; the `q` parameter only changes the output on Cloudflare. Development responses use `Cache-Control: public, max-age=0, must-revalidate` and skip the cache. If local transformations are unavailable, the endpoint serves original files and logs a warning.

Remote sources are fetched from the network, so they need to be reachable from your machine.

## Deployment

### Your Cloudflare account

When your app imports `Image` or `getImageProps` and uses the default loader, Void adds a Cloudflare Images binding named `IMAGES` to your Worker and serves `/_void/image` with it.

Void finds these imports in the files it [scans for resources](../reference/resource-inference.md#scanned-directories). When only code outside those files imports `Image`, such as a shared UI package in a monorepo, Void doesn't serve `/_void/image`, in development or after deploying, and those images fail to load. Set `inference.bindings.images` to `true` to add the binding and serve `/_void/image`:

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  inference: { bindings: { images: true } },
});
```

Reading `env.IMAGES` or `c.env.IMAGES` in server code also adds the binding, so you can call the [Images binding](https://developers.cloudflare.com/images/transform-images/bindings/) directly.

[`inference.bindings.images`](../reference/config.md#inference-bindings) also renames or removes the binding. Set it to a name, such as `'MY_IMAGES'`, to rename the binding. With `false`, Void deploys without the binding and `/_void/image` serves original files. To turn optimization off entirely, set `images.unoptimized: true`.

#### Free allowance

Image optimization works on Workers Free. The [Cloudflare Images Free plan](https://developers.cloudflare.com/images/pricing/) includes 5,000 unique transformations per month at no charge. A unique transformation is one source image at one set of parameters, such as width and quality, and Cloudflare counts it once per calendar month however often it is requested. A responsive image can use several, one for each width that browsers request.

When the month's allowance is used up, Cloudflare doesn't charge you. Optimized images already in the cache keep being served, and requests for transformations Cloudflare refuses serve the original file until the next month. To use fewer transformations, shorten `images.deviceSizes` and `images.imageSizes`. See [Cloudflare Images pricing](https://developers.cloudflare.com/images/pricing/) for paid limits.

### Void Platform

Void Platform doesn't provide image optimization yet. `Image` renders original files there, as if `images.unoptimized` were set, and `void deploy` prints a warning. A custom loader or the `cloudflare` loader still applies.

The Images binding isn't available on Void Platform either, so `env.IMAGES` is `undefined` there. To call the binding directly, deploy to [your Cloudflare account](../reference/cli/deploy.md#void-deploy-platform-cloudflare).

### Other targets and static output

With [`target`](../reference/config.md#target) set to `node`, `bun`, or `deno`, or with [`output: "static"`](../reference/config.md#output), there is no `/_void/image` endpoint. `Image` renders original files, as if `images.unoptimized` were set, unless you configure a [custom loader](#loaders) that points at an image service.

## Islands

In [island pages](./pages-routing/islands.md), an `Image` outside an island is static HTML. The `srcset` and lazy loading work as on other pages, but `onLoad` and `onError` don't run and a blur placeholder isn't removed after the image loads, so it stays visible behind transparent images. Render the image inside an island when you need those behaviors.

## Migrating from `next/image`

`Image` accepts the same props as `next/image` and renders the same `<img>` attributes. In React, `@void/react/image` has the same exports as the `next/image` module:

```tsx
import Image, { getImageProps } from '@void/react/image';
```

Replace `next/image` imports with `@void/react/image`. To keep `next/image` imports in code you don't want to change, alias the module in your Vite config:

```ts
// vite.config.ts
import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
  resolve: {
    alias: { 'next/image': '@void/react/image' },
  },
});
```

Void detects image usage from `next/image` imports too, so the alias needs no other configuration. The alias only affects bundling; TypeScript still has to resolve `next/image` on its own.

Move the `images` object from `next.config.js` to `void.config.ts`. The keys, types, and defaults are the same, and loader functions and `loaderFile` modules work unchanged.

These differences remain:

- The endpoint path is `/_void/image` instead of `/_next/image`. Its cache status header is `X-Void-Image-Cache`.
- Static image imports need `?image`. An import without it returns the URL string.
- `blurDataURL` isn't generated for imported images. Pass it yourself with `placeholder="blur"`.
- AVIF output is limited to 1,200 pixels wide; wider images use the next format in `images.formats`.
- `images.maximumResponseBody` is capped at 20 MB.
- Remote hostnames aren't resolved before fetching, so `images.dangerouslyAllowLocalIP` only governs `localhost` and IP addresses written in the URL. Redirect targets must also match `images.remotePatterns`.
- `images.maximumDiskCacheSize`, `images.disableStaticImages`, and `images.customCacheHandler` are accepted but have no effect, and Void prints a warning. `images.domains` is deprecated as in Next.js; use `remotePatterns`.

See [`images`](../reference/config.md#images) for every configuration key.

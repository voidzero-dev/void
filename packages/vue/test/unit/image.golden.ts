/**
 * Expected Vue server markup for `Image`, translated from the markup
 * next@16.4.2's real `Image` renders with react-dom 19.3.0
 * (`renderToStaticMarkup`, `NODE_ENV=production`, Next.js's default image
 * options with `path: '/_void/image'`). The translation only changes how the
 * same markup is spelled:
 * - React's `srcSet`, `fetchPriority`, `referrerPolicy`, `imageSrcSet` and
 *   `imageSizes` become HTML names, `/>` becomes `>`, `&#x27;` becomes
 *   `&#39;`, and empty values print as bare attributes (`alt`), as Vue does;
 * - the preload `<link>` React prints in the tree moves to `preload`, with
 *   React's `crossorigin=""` spelled `"anonymous"`. React DOM's own preloads
 *   of non-lazy images (not from `preload` / `priority`) are dropped;
 * - props use `class` for `className`.
 * Regenerate with the scratch script that translates the React golden module;
 * do not edit by hand.
 */
import type { ImageProps } from '../../src/runtime/image.ts';

export type ImageVueGoldenCase = {
  name: string;
  props: ImageProps & Record<string, unknown>;
  /** The rendered `<img>`. */
  html: string;
  /** The `<link rel="preload" as="image">` collected for `<head>`, if any. */
  preload: string | null;
};

export const imageVueGoldenCases: Array<ImageVueGoldenCase> = [
  {
    name: 'fixed width (1x/2x)',
    props: {
      src: '/avatars/ada.png',
      alt: 'Ada',
      width: 64,
      height: 64,
    },
    html: '<img alt="Ada" loading="lazy" width="64" height="64" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Favatars%2Fada.png&amp;w=64&amp;q=75 1x, /_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75 2x" src="/_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75">',
    preload: null,
  },
  {
    name: 'numeric string dimensions',
    props: {
      src: '/photos/a.jpg',
      alt: 'A',
      width: '500',
      height: '300',
    },
    html: '<img alt="A" loading="lazy" width="500" height="300" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fphotos%2Fa.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphotos%2Fa.jpg&amp;w=1080&amp;q=75 2x" src="/_void/image?url=%2Fphotos%2Fa.jpg&amp;w=1080&amp;q=75">',
    preload: null,
  },
  {
    name: 'sizes with vw',
    props: {
      src: '/hero.jpg',
      alt: 'Hero',
      width: 1200,
      height: 600,
      sizes: '(max-width: 768px) 100vw, 50vw',
    },
    html: '<img alt="Hero" loading="lazy" width="1200" height="600" decoding="async" data-nimg="1" style="color:transparent" sizes="(max-width: 768px) 100vw, 50vw" srcset="/_void/image?url=%2Fhero.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fhero.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fhero.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fhero.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fhero.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75">',
    preload: null,
  },
  {
    name: 'sizes without vw',
    props: {
      src: '/hero.jpg',
      alt: 'Hero',
      width: 300,
      height: 200,
      sizes: '300px',
    },
    html: '<img alt="Hero" loading="lazy" width="300" height="200" decoding="async" data-nimg="1" style="color:transparent" sizes="300px" srcset="/_void/image?url=%2Fhero.jpg&amp;w=32&amp;q=75 32w, /_void/image?url=%2Fhero.jpg&amp;w=48&amp;q=75 48w, /_void/image?url=%2Fhero.jpg&amp;w=64&amp;q=75 64w, /_void/image?url=%2Fhero.jpg&amp;w=96&amp;q=75 96w, /_void/image?url=%2Fhero.jpg&amp;w=128&amp;q=75 128w, /_void/image?url=%2Fhero.jpg&amp;w=256&amp;q=75 256w, /_void/image?url=%2Fhero.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fhero.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fhero.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fhero.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fhero.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75">',
    preload: null,
  },
  {
    name: 'fill',
    props: {
      src: '/cover.jpg',
      alt: 'Cover',
      fill: true,
    },
    html: '<img alt="Cover" loading="lazy" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent" sizes="100vw" srcset="/_void/image?url=%2Fcover.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fcover.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fcover.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fcover.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fcover.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fcover.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fcover.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75">',
    preload: null,
  },
  {
    name: 'fill with sizes and objectFit',
    props: {
      src: '/cover.jpg',
      alt: 'Cover',
      fill: true,
      sizes: '33vw',
      style: {
        objectFit: 'cover',
      },
    },
    html: '<img alt="Cover" loading="lazy" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:cover;color:transparent" sizes="33vw" srcset="/_void/image?url=%2Fcover.jpg&amp;w=256&amp;q=75 256w, /_void/image?url=%2Fcover.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fcover.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fcover.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fcover.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fcover.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fcover.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fcover.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fcover.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75">',
    preload: null,
  },
  {
    name: 'preload',
    props: {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
    },
    html: '<img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75">',
    preload:
      '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x">',
  },
  {
    name: 'priority',
    props: {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      priority: true,
    },
    html: '<img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75">',
    preload:
      '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x">',
  },
  {
    name: 'preload with fetchPriority high',
    props: {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
      fetchPriority: 'high',
    },
    html: '<img alt="LCP" fetchpriority="high" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75">',
    preload:
      '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" fetchpriority="high">',
  },
  {
    name: 'preload fill with crossOrigin and referrerPolicy',
    props: {
      src: 'https://images.example.com/lcp.jpg',
      alt: 'LCP',
      fill: true,
      sizes: '100vw',
      preload: true,
      crossOrigin: 'anonymous',
      referrerPolicy: 'no-referrer',
    },
    html: '<img alt="LCP" crossorigin="anonymous" referrerpolicy="no-referrer" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent" sizes="100vw" srcset="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75">',
    preload:
      '<link rel="preload" as="image" imagesrcset="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" imagesizes="100vw" crossorigin="anonymous" referrerpolicy="no-referrer">',
  },
  {
    name: 'preload unoptimized',
    props: {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
      unoptimized: true,
    },
    html: '<img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" src="/lcp.jpg">',
    preload: '<link rel="preload" as="image" href="/lcp.jpg">',
  },
  {
    name: 'loading eager',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      loading: 'eager',
    },
    html: '<img alt="A" loading="eager" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75">',
    preload: null,
  },
  {
    name: 'fetchPriority low',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      fetchPriority: 'low',
    },
    html: '<img alt="A" fetchpriority="low" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75">',
    preload: null,
  },
  {
    name: 'unoptimized',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      unoptimized: true,
    },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" src="/a.png">',
    preload: null,
  },
  {
    name: 'custom loader prop',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      quality: 60,
      loader: ({ src, width, quality }) =>
        `https://cdn.example.com${src}?w=${width}&q=${quality || 75}`,
    },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="https://cdn.example.com/a.png?w=128&amp;q=60 1x, https://cdn.example.com/a.png?w=256&amp;q=60 2x" src="https://cdn.example.com/a.png?w=256&amp;q=60">',
    preload: null,
  },
  {
    name: 'overrideSrc',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      overrideSrc: '/seo/original.png',
    },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/seo/original.png">',
    preload: null,
  },
  {
    name: 'placeholder blur',
    props: {
      src: '/photo.jpg',
      alt: 'Photo',
      width: 400,
      height: 300,
      placeholder: 'blur',
      blurDataURL: 'data:image/png;base64,iVBORw0KGgo=',
    },
    html: '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#39;http://www.w3.org/2000/svg&#39; viewBox=&#39;0 0 400 300&#39;%3E%3Cfilter id=&#39;b&#39; color-interpolation-filters=&#39;sRGB&#39;%3E%3CfeGaussianBlur stdDeviation=&#39;20&#39;/%3E%3CfeColorMatrix values=&#39;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#39; result=&#39;s&#39;/%3E%3CfeFlood x=&#39;0&#39; y=&#39;0&#39; width=&#39;100%25&#39; height=&#39;100%25&#39;/%3E%3CfeComposite operator=&#39;out&#39; in=&#39;s&#39;/%3E%3CfeComposite in2=&#39;SourceGraphic&#39;/%3E%3CfeGaussianBlur stdDeviation=&#39;20&#39;/%3E%3C/filter%3E%3Cimage width=&#39;100%25&#39; height=&#39;100%25&#39; x=&#39;0&#39; y=&#39;0&#39; preserveAspectRatio=&#39;none&#39; style=&#39;filter: url(%23b);&#39; href=&#39;data:image/png;base64,iVBORw0KGgo=&#39;/%3E%3C/svg%3E&quot;)" srcset="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75">',
    preload: null,
  },
  {
    name: 'placeholder blur with objectFit contain',
    props: {
      src: '/photo.jpg',
      alt: 'Photo',
      width: 400,
      height: 300,
      placeholder: 'blur',
      blurDataURL: 'data:image/png;base64,iVBORw0KGgo=',
      style: {
        objectFit: 'contain',
      },
    },
    html: '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;object-fit:contain;background-size:contain;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#39;http://www.w3.org/2000/svg&#39; viewBox=&#39;0 0 400 300&#39;%3E%3Cfilter id=&#39;b&#39; color-interpolation-filters=&#39;sRGB&#39;%3E%3CfeGaussianBlur stdDeviation=&#39;20&#39;/%3E%3CfeColorMatrix values=&#39;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#39; result=&#39;s&#39;/%3E%3CfeFlood x=&#39;0&#39; y=&#39;0&#39; width=&#39;100%25&#39; height=&#39;100%25&#39;/%3E%3CfeComposite operator=&#39;out&#39; in=&#39;s&#39;/%3E%3CfeComposite in2=&#39;SourceGraphic&#39;/%3E%3CfeGaussianBlur stdDeviation=&#39;20&#39;/%3E%3C/filter%3E%3Cimage width=&#39;100%25&#39; height=&#39;100%25&#39; x=&#39;0&#39; y=&#39;0&#39; preserveAspectRatio=&#39;none&#39; style=&#39;filter: url(%23b);&#39; href=&#39;data:image/png;base64,iVBORw0KGgo=&#39;/%3E%3C/svg%3E&quot;)" srcset="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75">',
    preload: null,
  },
  {
    name: 'data:image placeholder',
    props: {
      src: '/photo.jpg',
      alt: 'Photo',
      width: 400,
      height: 300,
      placeholder: 'data:image/png;base64,iVBORw0KGgo=',
    },
    html: '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/png;base64,iVBORw0KGgo=&quot;)" srcset="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75">',
    preload: null,
  },
  {
    name: 'placeholder empty',
    props: {
      src: '/photo.jpg',
      alt: 'Photo',
      width: 400,
      height: 300,
      placeholder: 'empty',
    },
    html: '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75">',
    preload: null,
  },
  {
    name: 'className and style',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      class: 'rounded shadow',
      style: {
        borderRadius: 8,
        maxWidth: '100%',
        height: 'auto',
      },
    },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" class="rounded shadow" style="color:transparent;border-radius:8px;max-width:100%;height:auto" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75">',
    preload: null,
  },
  {
    name: 'svg src',
    props: {
      src: '/logo.svg',
      alt: 'Logo',
      width: 120,
      height: 40,
    },
    html: '<img alt="Logo" loading="lazy" width="120" height="40" decoding="async" data-nimg="1" style="color:transparent" src="/logo.svg">',
    preload: null,
  },
  {
    name: 'remote absolute src',
    props: {
      src: 'https://images.example.com/photos/a.jpg?id=1',
      alt: 'Remote',
      width: 640,
      height: 480,
    },
    html: '<img alt="Remote" loading="lazy" width="640" height="480" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=640&amp;q=75 1x, /_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=1920&amp;q=75 2x" src="/_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=1920&amp;q=75">',
    preload: null,
  },
  {
    name: 'quality',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      quality: 50,
    },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75">',
    preload: null,
  },
  {
    name: 'width above every configured size',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 5000,
      height: 100,
    },
    html: '<img alt="A" loading="lazy" width="5000" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75 1x" src="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75">',
    preload: null,
  },
  {
    name: 'static import',
    props: {
      src: {
        src: '/assets/hero-abc123.jpg',
        width: 1600,
        height: 900,
      },
      alt: 'Hero',
    },
    html: '<img alt="Hero" loading="lazy" width="1600" height="900" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75 1x, /_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75 2x" src="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75">',
    preload: null,
  },
  {
    name: 'static import with width and blur',
    props: {
      src: {
        src: '/assets/hero-abc123.jpg',
        width: 1600,
        height: 900,
        blurDataURL: 'data:image/jpeg;base64,/9j/',
        blurWidth: 8,
        blurHeight: 5,
      },
      alt: 'Hero',
      width: 800,
      placeholder: 'blur',
    },
    html: '<img alt="Hero" loading="lazy" width="800" height="450" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#39;http://www.w3.org/2000/svg&#39; viewBox=&#39;0 0 320 200&#39;%3E%3Cfilter id=&#39;b&#39; color-interpolation-filters=&#39;sRGB&#39;%3E%3CfeGaussianBlur stdDeviation=&#39;20&#39;/%3E%3CfeColorMatrix values=&#39;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#39; result=&#39;s&#39;/%3E%3CfeFlood x=&#39;0&#39; y=&#39;0&#39; width=&#39;100%25&#39; height=&#39;100%25&#39;/%3E%3CfeComposite operator=&#39;out&#39; in=&#39;s&#39;/%3E%3CfeComposite in2=&#39;SourceGraphic&#39;/%3E%3CfeGaussianBlur stdDeviation=&#39;20&#39;/%3E%3C/filter%3E%3Cimage width=&#39;100%25&#39; height=&#39;100%25&#39; x=&#39;0&#39; y=&#39;0&#39; preserveAspectRatio=&#39;none&#39; style=&#39;filter: url(%23b);&#39; href=&#39;data:image/jpeg;base64,/9j/&#39;/%3E%3C/svg%3E&quot;)" srcset="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75">',
    preload: null,
  },
  {
    name: 'data: src',
    props: {
      src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      alt: 'Pixel',
      width: 1,
      height: 1,
    },
    html: '<img alt="Pixel" width="1" height="1" decoding="async" data-nimg="1" style="color:transparent" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
    preload: null,
  },
  {
    name: 'empty alt',
    props: {
      src: '/a.png',
      alt: '',
      width: 100,
      height: 100,
    },
    html: '<img alt loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75">',
    preload: null,
  },
  {
    name: 'extra img attributes and handlers',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      id: 'avatar',
      title: 'Ada',
      decoding: 'sync',
      draggable: false,
      'data-testid': 'avatar',
      onLoad: () => {},
      onError: () => {},
    },
    html: '<img alt="A" id="avatar" title="Ada" draggable="false" data-testid="avatar" loading="lazy" width="100" height="100" decoding="sync" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75">',
    preload: null,
  },
  {
    name: 'legacy layout responsive',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      layout: 'responsive',
    },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent;width:100%;height:auto" sizes="100vw" srcset="/_void/image?url=%2Fa.png&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fa.png&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fa.png&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fa.png&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fa.png&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fa.png&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fa.png&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fa.png&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75">',
    preload: null,
  },
];

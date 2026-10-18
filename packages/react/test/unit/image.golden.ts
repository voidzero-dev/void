/**
 * Golden output of next@16.4.2: its real `Image` (`next/dist/client/image-component.js`)
 * and `getImageProps` (`next/dist/shared/lib/image-external-get-image-props.js`),
 * run in Node with react@19.3.0 and react-dom@19.3.0, `NODE_ENV=production`, and
 * `process.env.__NEXT_IMAGE_OPTS` set to the object `next build` inlines for
 * Next.js's default `images` config with `path: '/_void/image'`.
 * `staticMarkup` is `renderToStaticMarkup(<Image {...props} />)`; `tree` is
 * `renderToString(<main><Image {...props} /></main>)`, which includes the
 * `ReactDOM.preload` link of preloaded images. Function props were written with
 * `Function#toString`. Regenerate the same way after changing a case; do not
 * edit the expected strings by hand.
 */
import type { ImageProps } from '../../src/runtime/image.tsx';

export type ImageGoldenCase = {
  name: string;
  /** `Image` props; JSX types `data-*` attributes separately. */
  props: ImageProps & { [key: `data-${string}`]: string };
  staticMarkup: string;
  tree: string;
};

export const imageGoldenCases: Array<ImageGoldenCase> = [
  {
    name: 'fixed width (1x/2x)',
    props: {
      src: '/avatars/ada.png',
      alt: 'Ada',
      width: 64,
      height: 64,
    },
    staticMarkup:
      '<img alt="Ada" loading="lazy" width="64" height="64" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Favatars%2Fada.png&amp;w=64&amp;q=75 1x, /_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75 2x" src="/_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75"/>',
    tree: '<main><img alt="Ada" loading="lazy" width="64" height="64" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Favatars%2Fada.png&amp;w=64&amp;q=75 1x, /_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75 2x" src="/_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75"/></main>',
  },
  {
    name: 'numeric string dimensions',
    props: {
      src: '/photos/a.jpg',
      alt: 'A',
      width: '500',
      height: '300',
    },
    staticMarkup:
      '<img alt="A" loading="lazy" width="500" height="300" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fphotos%2Fa.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphotos%2Fa.jpg&amp;w=1080&amp;q=75 2x" src="/_void/image?url=%2Fphotos%2Fa.jpg&amp;w=1080&amp;q=75"/>',
    tree: '<main><img alt="A" loading="lazy" width="500" height="300" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fphotos%2Fa.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphotos%2Fa.jpg&amp;w=1080&amp;q=75 2x" src="/_void/image?url=%2Fphotos%2Fa.jpg&amp;w=1080&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Hero" loading="lazy" width="1200" height="600" decoding="async" data-nimg="1" style="color:transparent" sizes="(max-width: 768px) 100vw, 50vw" srcSet="/_void/image?url=%2Fhero.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fhero.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fhero.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fhero.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fhero.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75"/>',
    tree: '<main><img alt="Hero" loading="lazy" width="1200" height="600" decoding="async" data-nimg="1" style="color:transparent" sizes="(max-width: 768px) 100vw, 50vw" srcSet="/_void/image?url=%2Fhero.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fhero.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fhero.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fhero.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fhero.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Hero" loading="lazy" width="300" height="200" decoding="async" data-nimg="1" style="color:transparent" sizes="300px" srcSet="/_void/image?url=%2Fhero.jpg&amp;w=32&amp;q=75 32w, /_void/image?url=%2Fhero.jpg&amp;w=48&amp;q=75 48w, /_void/image?url=%2Fhero.jpg&amp;w=64&amp;q=75 64w, /_void/image?url=%2Fhero.jpg&amp;w=96&amp;q=75 96w, /_void/image?url=%2Fhero.jpg&amp;w=128&amp;q=75 128w, /_void/image?url=%2Fhero.jpg&amp;w=256&amp;q=75 256w, /_void/image?url=%2Fhero.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fhero.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fhero.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fhero.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fhero.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75"/>',
    tree: '<main><img alt="Hero" loading="lazy" width="300" height="200" decoding="async" data-nimg="1" style="color:transparent" sizes="300px" srcSet="/_void/image?url=%2Fhero.jpg&amp;w=32&amp;q=75 32w, /_void/image?url=%2Fhero.jpg&amp;w=48&amp;q=75 48w, /_void/image?url=%2Fhero.jpg&amp;w=64&amp;q=75 64w, /_void/image?url=%2Fhero.jpg&amp;w=96&amp;q=75 96w, /_void/image?url=%2Fhero.jpg&amp;w=128&amp;q=75 128w, /_void/image?url=%2Fhero.jpg&amp;w=256&amp;q=75 256w, /_void/image?url=%2Fhero.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fhero.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fhero.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fhero.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fhero.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75"/></main>',
  },
  {
    name: 'fill',
    props: {
      src: '/cover.jpg',
      alt: 'Cover',
      fill: true,
    },
    staticMarkup:
      '<img alt="Cover" loading="lazy" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent" sizes="100vw" srcSet="/_void/image?url=%2Fcover.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fcover.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fcover.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fcover.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fcover.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fcover.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fcover.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75"/>',
    tree: '<main><img alt="Cover" loading="lazy" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent" sizes="100vw" srcSet="/_void/image?url=%2Fcover.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fcover.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fcover.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fcover.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fcover.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fcover.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fcover.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Cover" loading="lazy" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:cover;color:transparent" sizes="33vw" srcSet="/_void/image?url=%2Fcover.jpg&amp;w=256&amp;q=75 256w, /_void/image?url=%2Fcover.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fcover.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fcover.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fcover.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fcover.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fcover.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fcover.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fcover.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75"/>',
    tree: '<main><img alt="Cover" loading="lazy" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:cover;color:transparent" sizes="33vw" srcSet="/_void/image?url=%2Fcover.jpg&amp;w=256&amp;q=75 256w, /_void/image?url=%2Fcover.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fcover.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fcover.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fcover.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fcover.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fcover.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fcover.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fcover.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75"/></main>',
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
    staticMarkup:
      '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x"/><img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/>',
    tree: '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x"/><main><img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/></main>',
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
    staticMarkup:
      '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x"/><img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/>',
    tree: '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x"/><main><img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/></main>',
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
    staticMarkup:
      '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" fetchPriority="high"/><img alt="LCP" fetchPriority="high" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/>',
    tree: '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" fetchPriority="high"/><main><img alt="LCP" fetchPriority="high" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/></main>',
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
    staticMarkup:
      '<link rel="preload" as="image" imageSrcSet="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" imageSizes="100vw" crossorigin="" referrerPolicy="no-referrer"/><img alt="LCP" crossorigin="anonymous" referrerPolicy="no-referrer" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent" sizes="100vw" srcSet="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75"/>',
    tree: '<link rel="preload" as="image" imageSrcSet="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" imageSizes="100vw" crossorigin="" referrerPolicy="no-referrer"/><main><img alt="LCP" crossorigin="anonymous" referrerPolicy="no-referrer" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent" sizes="100vw" srcSet="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75"/></main>',
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
    staticMarkup:
      '<link rel="preload" as="image" href="/lcp.jpg"/><img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" src="/lcp.jpg"/>',
    tree: '<link rel="preload" as="image" href="/lcp.jpg"/><main><img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" src="/lcp.jpg"/></main>',
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
    staticMarkup:
      '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x"/><img alt="A" loading="eager" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
    tree: '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x"/><main><img alt="A" loading="eager" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="A" fetchPriority="low" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
    tree: '<main><img alt="A" fetchPriority="low" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" src="/a.png"/>',
    tree: '<main><img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" src="/a.png"/></main>',
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
    staticMarkup:
      '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="https://cdn.example.com/a.png?w=128&amp;q=60 1x, https://cdn.example.com/a.png?w=256&amp;q=60 2x" src="https://cdn.example.com/a.png?w=256&amp;q=60"/>',
    tree: '<main><img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="https://cdn.example.com/a.png?w=128&amp;q=60 1x, https://cdn.example.com/a.png?w=256&amp;q=60 2x" src="https://cdn.example.com/a.png?w=256&amp;q=60"/></main>',
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
    staticMarkup:
      '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/seo/original.png"/>',
    tree: '<main><img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/seo/original.png"/></main>',
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
    staticMarkup:
      '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#x27;http://www.w3.org/2000/svg&#x27; viewBox=&#x27;0 0 400 300&#x27;%3E%3Cfilter id=&#x27;b&#x27; color-interpolation-filters=&#x27;sRGB&#x27;%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3CfeColorMatrix values=&#x27;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#x27; result=&#x27;s&#x27;/%3E%3CfeFlood x=&#x27;0&#x27; y=&#x27;0&#x27; width=&#x27;100%25&#x27; height=&#x27;100%25&#x27;/%3E%3CfeComposite operator=&#x27;out&#x27; in=&#x27;s&#x27;/%3E%3CfeComposite in2=&#x27;SourceGraphic&#x27;/%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3C/filter%3E%3Cimage width=&#x27;100%25&#x27; height=&#x27;100%25&#x27; x=&#x27;0&#x27; y=&#x27;0&#x27; preserveAspectRatio=&#x27;none&#x27; style=&#x27;filter: url(%23b);&#x27; href=&#x27;data:image/png;base64,iVBORw0KGgo=&#x27;/%3E%3C/svg%3E&quot;)" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/>',
    tree: '<main><img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#x27;http://www.w3.org/2000/svg&#x27; viewBox=&#x27;0 0 400 300&#x27;%3E%3Cfilter id=&#x27;b&#x27; color-interpolation-filters=&#x27;sRGB&#x27;%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3CfeColorMatrix values=&#x27;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#x27; result=&#x27;s&#x27;/%3E%3CfeFlood x=&#x27;0&#x27; y=&#x27;0&#x27; width=&#x27;100%25&#x27; height=&#x27;100%25&#x27;/%3E%3CfeComposite operator=&#x27;out&#x27; in=&#x27;s&#x27;/%3E%3CfeComposite in2=&#x27;SourceGraphic&#x27;/%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3C/filter%3E%3Cimage width=&#x27;100%25&#x27; height=&#x27;100%25&#x27; x=&#x27;0&#x27; y=&#x27;0&#x27; preserveAspectRatio=&#x27;none&#x27; style=&#x27;filter: url(%23b);&#x27; href=&#x27;data:image/png;base64,iVBORw0KGgo=&#x27;/%3E%3C/svg%3E&quot;)" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;object-fit:contain;background-size:contain;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#x27;http://www.w3.org/2000/svg&#x27; viewBox=&#x27;0 0 400 300&#x27;%3E%3Cfilter id=&#x27;b&#x27; color-interpolation-filters=&#x27;sRGB&#x27;%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3CfeColorMatrix values=&#x27;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#x27; result=&#x27;s&#x27;/%3E%3CfeFlood x=&#x27;0&#x27; y=&#x27;0&#x27; width=&#x27;100%25&#x27; height=&#x27;100%25&#x27;/%3E%3CfeComposite operator=&#x27;out&#x27; in=&#x27;s&#x27;/%3E%3CfeComposite in2=&#x27;SourceGraphic&#x27;/%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3C/filter%3E%3Cimage width=&#x27;100%25&#x27; height=&#x27;100%25&#x27; x=&#x27;0&#x27; y=&#x27;0&#x27; preserveAspectRatio=&#x27;none&#x27; style=&#x27;filter: url(%23b);&#x27; href=&#x27;data:image/png;base64,iVBORw0KGgo=&#x27;/%3E%3C/svg%3E&quot;)" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/>',
    tree: '<main><img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;object-fit:contain;background-size:contain;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#x27;http://www.w3.org/2000/svg&#x27; viewBox=&#x27;0 0 400 300&#x27;%3E%3Cfilter id=&#x27;b&#x27; color-interpolation-filters=&#x27;sRGB&#x27;%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3CfeColorMatrix values=&#x27;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#x27; result=&#x27;s&#x27;/%3E%3CfeFlood x=&#x27;0&#x27; y=&#x27;0&#x27; width=&#x27;100%25&#x27; height=&#x27;100%25&#x27;/%3E%3CfeComposite operator=&#x27;out&#x27; in=&#x27;s&#x27;/%3E%3CfeComposite in2=&#x27;SourceGraphic&#x27;/%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3C/filter%3E%3Cimage width=&#x27;100%25&#x27; height=&#x27;100%25&#x27; x=&#x27;0&#x27; y=&#x27;0&#x27; preserveAspectRatio=&#x27;none&#x27; style=&#x27;filter: url(%23b);&#x27; href=&#x27;data:image/png;base64,iVBORw0KGgo=&#x27;/%3E%3C/svg%3E&quot;)" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/png;base64,iVBORw0KGgo=&quot;)" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/>',
    tree: '<main><img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/png;base64,iVBORw0KGgo=&quot;)" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/>',
    tree: '<main><img alt="Photo" loading="lazy" width="400" height="300" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x" src="/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75"/></main>',
  },
  {
    name: 'className and style',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      className: 'rounded shadow',
      style: {
        borderRadius: 8,
        maxWidth: '100%',
        height: 'auto',
      },
    },
    staticMarkup:
      '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" class="rounded shadow" style="color:transparent;border-radius:8px;max-width:100%;height:auto" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
    tree: '<main><img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" class="rounded shadow" style="color:transparent;border-radius:8px;max-width:100%;height:auto" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/></main>',
  },
  {
    name: 'svg src',
    props: {
      src: '/logo.svg',
      alt: 'Logo',
      width: 120,
      height: 40,
    },
    staticMarkup:
      '<img alt="Logo" loading="lazy" width="120" height="40" decoding="async" data-nimg="1" style="color:transparent" src="/logo.svg"/>',
    tree: '<main><img alt="Logo" loading="lazy" width="120" height="40" decoding="async" data-nimg="1" style="color:transparent" src="/logo.svg"/></main>',
  },
  {
    name: 'remote absolute src',
    props: {
      src: 'https://images.example.com/photos/a.jpg?id=1',
      alt: 'Remote',
      width: 640,
      height: 480,
    },
    staticMarkup:
      '<img alt="Remote" loading="lazy" width="640" height="480" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=640&amp;q=75 1x, /_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=1920&amp;q=75 2x" src="/_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=1920&amp;q=75"/>',
    tree: '<main><img alt="Remote" loading="lazy" width="640" height="480" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=640&amp;q=75 1x, /_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=1920&amp;q=75 2x" src="/_void/image?url=https%3A%2F%2Fimages.example.com%2Fphotos%2Fa.jpg%3Fid%3D1&amp;w=1920&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
    tree: '<main><img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/></main>',
  },
  {
    name: 'width above every configured size',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 5000,
      height: 100,
    },
    staticMarkup:
      '<img alt="A" loading="lazy" width="5000" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75 1x" src="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75"/>',
    tree: '<main><img alt="A" loading="lazy" width="5000" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75 1x" src="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Hero" loading="lazy" width="1600" height="900" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75 1x, /_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75 2x" src="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75"/>',
    tree: '<main><img alt="Hero" loading="lazy" width="1600" height="900" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75 1x, /_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75 2x" src="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="Hero" loading="lazy" width="800" height="450" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#x27;http://www.w3.org/2000/svg&#x27; viewBox=&#x27;0 0 320 200&#x27;%3E%3Cfilter id=&#x27;b&#x27; color-interpolation-filters=&#x27;sRGB&#x27;%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3CfeColorMatrix values=&#x27;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#x27; result=&#x27;s&#x27;/%3E%3CfeFlood x=&#x27;0&#x27; y=&#x27;0&#x27; width=&#x27;100%25&#x27; height=&#x27;100%25&#x27;/%3E%3CfeComposite operator=&#x27;out&#x27; in=&#x27;s&#x27;/%3E%3CfeComposite in2=&#x27;SourceGraphic&#x27;/%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3C/filter%3E%3Cimage width=&#x27;100%25&#x27; height=&#x27;100%25&#x27; x=&#x27;0&#x27; y=&#x27;0&#x27; preserveAspectRatio=&#x27;none&#x27; style=&#x27;filter: url(%23b);&#x27; href=&#x27;data:image/jpeg;base64,/9j/&#x27;/%3E%3C/svg%3E&quot;)" srcSet="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75"/>',
    tree: '<main><img alt="Hero" loading="lazy" width="800" height="450" decoding="async" data-nimg="1" style="color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=&#x27;http://www.w3.org/2000/svg&#x27; viewBox=&#x27;0 0 320 200&#x27;%3E%3Cfilter id=&#x27;b&#x27; color-interpolation-filters=&#x27;sRGB&#x27;%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3CfeColorMatrix values=&#x27;1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1&#x27; result=&#x27;s&#x27;/%3E%3CfeFlood x=&#x27;0&#x27; y=&#x27;0&#x27; width=&#x27;100%25&#x27; height=&#x27;100%25&#x27;/%3E%3CfeComposite operator=&#x27;out&#x27; in=&#x27;s&#x27;/%3E%3CfeComposite in2=&#x27;SourceGraphic&#x27;/%3E%3CfeGaussianBlur stdDeviation=&#x27;20&#x27;/%3E%3C/filter%3E%3Cimage width=&#x27;100%25&#x27; height=&#x27;100%25&#x27; x=&#x27;0&#x27; y=&#x27;0&#x27; preserveAspectRatio=&#x27;none&#x27; style=&#x27;filter: url(%23b);&#x27; href=&#x27;data:image/jpeg;base64,/9j/&#x27;/%3E%3C/svg%3E&quot;)" srcSet="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75"/></main>',
  },
  {
    name: 'data: src',
    props: {
      src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      alt: 'Pixel',
      width: 1,
      height: 1,
    },
    staticMarkup:
      '<img alt="Pixel" width="1" height="1" decoding="async" data-nimg="1" style="color:transparent" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="/>',
    tree: '<main><img alt="Pixel" width="1" height="1" decoding="async" data-nimg="1" style="color:transparent" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="/></main>',
  },
  {
    name: 'empty alt',
    props: {
      src: '/a.png',
      alt: '',
      width: 100,
      height: 100,
    },
    staticMarkup:
      '<img alt="" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
    tree: '<main><img alt="" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="A" id="avatar" title="Ada" draggable="false" data-testid="avatar" loading="lazy" width="100" height="100" decoding="sync" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
    tree: '<main><img alt="A" id="avatar" title="Ada" draggable="false" data-testid="avatar" loading="lazy" width="100" height="100" decoding="sync" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/></main>',
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
    staticMarkup:
      '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent;width:100%;height:auto" sizes="100vw" srcSet="/_void/image?url=%2Fa.png&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fa.png&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fa.png&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fa.png&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fa.png&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fa.png&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fa.png&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fa.png&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75"/>',
    tree: '<main><img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent;width:100%;height:auto" sizes="100vw" srcSet="/_void/image?url=%2Fa.png&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fa.png&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fa.png&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fa.png&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fa.png&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fa.png&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fa.png&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fa.png&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fa.png&amp;w=3840&amp;q=75"/></main>',
  },
];

/** `renderToString` of two preloaded `Image`s with the same `src` (alt "LCP" and "LCP again"). */
export const imageGoldenDedupeTree: string =
  '<link rel="preload" as="image" imageSrcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x"/><main><img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/><img alt="LCP again" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcSet="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/></main>';

/** `getImageProps(props).props` from next@16.4.2, in key order. */
export const imageGoldenGetImageProps: Array<{
  name: string;
  props: ImageProps;
  result: Record<string, unknown>;
}> = [
  {
    name: 'fixed width',
    props: {
      src: '/avatars/ada.png',
      alt: 'Ada',
      width: 64,
      height: 64,
    },
    result: {
      alt: 'Ada',
      loading: 'lazy',
      width: 64,
      height: 64,
      decoding: 'async',
      style: {
        color: 'transparent',
      },
      srcSet:
        '/_void/image?url=%2Favatars%2Fada.png&w=64&q=75 1x, /_void/image?url=%2Favatars%2Fada.png&w=128&q=75 2x',
      src: '/_void/image?url=%2Favatars%2Fada.png&w=128&q=75',
    },
  },
  {
    name: 'fill with sizes',
    props: {
      src: '/cover.jpg',
      alt: 'Cover',
      fill: true,
      sizes: '50vw',
    },
    result: {
      alt: 'Cover',
      loading: 'lazy',
      decoding: 'async',
      style: {
        position: 'absolute',
        height: '100%',
        width: '100%',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        objectFit: undefined,
        objectPosition: undefined,
        color: 'transparent',
      },
      sizes: '50vw',
      srcSet:
        '/_void/image?url=%2Fcover.jpg&w=384&q=75 384w, /_void/image?url=%2Fcover.jpg&w=640&q=75 640w, /_void/image?url=%2Fcover.jpg&w=750&q=75 750w, /_void/image?url=%2Fcover.jpg&w=828&q=75 828w, /_void/image?url=%2Fcover.jpg&w=1080&q=75 1080w, /_void/image?url=%2Fcover.jpg&w=1200&q=75 1200w, /_void/image?url=%2Fcover.jpg&w=1920&q=75 1920w, /_void/image?url=%2Fcover.jpg&w=2048&q=75 2048w, /_void/image?url=%2Fcover.jpg&w=3840&q=75 3840w',
      src: '/_void/image?url=%2Fcover.jpg&w=3840&q=75',
    },
  },
  {
    name: 'preload with className and fetchPriority',
    props: {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
      fetchPriority: 'high',
      className: 'hero',
    },
    result: {
      alt: 'LCP',
      fetchPriority: 'high',
      width: 800,
      height: 400,
      decoding: 'async',
      className: 'hero',
      style: {
        color: 'transparent',
      },
      srcSet:
        '/_void/image?url=%2Flcp.jpg&w=828&q=75 1x, /_void/image?url=%2Flcp.jpg&w=1920&q=75 2x',
      src: '/_void/image?url=%2Flcp.jpg&w=1920&q=75',
    },
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
    result: {
      alt: 'A',
      loading: 'lazy',
      width: 100,
      height: 100,
      decoding: 'async',
      style: {
        color: 'transparent',
      },
      src: '/a.png',
    },
  },
];

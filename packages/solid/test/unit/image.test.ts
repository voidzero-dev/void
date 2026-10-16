import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Rolldown } from 'vite';
import solid from 'vite-plugin-solid';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { ImageProps } from '../../src/runtime/image-props.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');
const TMP = join(import.meta.dirname, '__tmp_image_ssr__');

type ServerRenderer = {
  /** Render `Image`s inside an `ImagePreloadContext` provider, as the page renderer does. */
  render(images: Array<ImageProps>): { html: string; head: string };
  /** Render an `Image` without a preload collector, as the browser does. */
  renderWithoutCollector(props: ImageProps): string;
};

let renderer: ServerRenderer;

/**
 * Compile the Solid `Image` as `vite-plugin-solid` compiles it for the
 * server (hydratable SSR output) and load it with Solid's server renderer.
 */
async function compileServerRenderer(): Promise<ServerRenderer> {
  const runtime = join(PACKAGE_ROOT, 'src', 'runtime');
  // Inside the package, so `solid-js` and `void` resolve as for an app.
  mkdirSync(TMP, { recursive: true });
  const entry = join(TMP, 'entry.ts');
  writeFileSync(
    entry,
    `
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createImagePreloadCollector } from "void/image";
import { ImagePreloadContext } from ${JSON.stringify(join(runtime, 'context.ts'))};
import { Image } from ${JSON.stringify(join(runtime, 'image.tsx'))};

export function render(images) {
  const preloads = createImagePreloadCollector();
  const html = renderToString(() =>
    createComponent(ImagePreloadContext.Provider, {
      value: preloads,
      get children() {
        return images.map((props) => createComponent(Image, props));
      },
    }),
  );
  return { html, head: preloads.render() };
}

export function renderWithoutCollector(props) {
  return renderToString(() => createComponent(Image, props));
}
`,
  );
  const output = (await build({
    root: PACKAGE_ROOT,
    configFile: false,
    logLevel: 'silent',
    plugins: [solid({ ssr: true })],
    build: {
      ssr: entry,
      write: false,
      minify: false,
      rollupOptions: { external: [/^solid-js(\/|$)/, /^void(\/|$)/] },
    },
  })) as Rolldown.RolldownOutput;
  const chunk = output.output.find((item) => item.type === 'chunk' && item.isEntry);
  if (!chunk || chunk.type !== 'chunk') {
    throw new Error('Expected an SSR entry chunk.');
  }
  const file = join(TMP, 'entry.mjs');
  writeFileSync(file, chunk.code);
  return (await import(pathToFileURL(file).href)) as ServerRenderer;
}

beforeAll(async () => {
  renderer = await compileServerRenderer();
}, 60_000);

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Server markup without Solid's hydration keys. */
function withoutHydrationKeys(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, '');
}

type MarkupCase = { name: string; props: ImageProps; html: string; head?: string };

/**
 * `html` is next@16.4.2's server markup for the same `next/image` props
 * (`images.path` set to `/_void/image`), spelled as Solid renders it: HTML
 * attribute names (`srcset`, `fetchpriority`, `referrerpolicy`) and `'`
 * left unescaped. `head` holds the preload links the page renderer puts into
 * `<head>`; Next.js renders the same links with React's attribute names.
 */
const markupCases: Array<MarkupCase> = [
  {
    name: 'fixed width (1x/2x)',
    props: { src: '/avatars/ada.png', alt: 'Ada', width: 64, height: 64 },
    html: '<img alt="Ada" loading="lazy" width="64" height="64" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Favatars%2Fada.png&amp;w=64&amp;q=75 1x, /_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75 2x" src="/_void/image?url=%2Favatars%2Fada.png&amp;w=128&amp;q=75"/>',
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
    html: '<img alt="Hero" loading="lazy" width="1200" height="600" decoding="async" data-nimg="1" style="color:transparent" sizes="(max-width: 768px) 100vw, 50vw" srcset="/_void/image?url=%2Fhero.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fhero.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fhero.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fhero.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fhero.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75"/>',
  },
  {
    name: 'fill with sizes and object-fit',
    props: {
      src: '/cover.jpg',
      alt: 'Cover',
      fill: true,
      sizes: '33vw',
      style: { 'object-fit': 'cover' },
    },
    html: '<img alt="Cover" loading="lazy" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:cover;color:transparent" sizes="33vw" srcset="/_void/image?url=%2Fcover.jpg&amp;w=256&amp;q=75 256w, /_void/image?url=%2Fcover.jpg&amp;w=384&amp;q=75 384w, /_void/image?url=%2Fcover.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=%2Fcover.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=%2Fcover.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=%2Fcover.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=%2Fcover.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=%2Fcover.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=%2Fcover.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=%2Fcover.jpg&amp;w=3840&amp;q=75"/>',
  },
  {
    name: 'preload with fetchpriority high',
    props: {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
      fetchpriority: 'high',
    },
    html: '<img alt="LCP" fetchpriority="high" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/>',
    head: '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" fetchpriority="high">',
  },
  {
    name: 'priority (deprecated preload)',
    props: { src: '/lcp.jpg', alt: 'LCP', width: 800, height: 400, priority: true },
    html: '<img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x" src="/_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75"/>',
    head: '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x">',
  },
  {
    name: 'preload fill with crossorigin and referrerpolicy',
    props: {
      src: 'https://images.example.com/lcp.jpg',
      alt: 'LCP',
      fill: true,
      sizes: '100vw',
      preload: true,
      crossorigin: 'anonymous',
      referrerpolicy: 'no-referrer',
    },
    html: '<img alt="LCP" crossorigin="anonymous" referrerpolicy="no-referrer" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent" sizes="100vw" srcset="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" src="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75"/>',
    head: '<link rel="preload" as="image" imagesrcset="/_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=640&amp;q=75 640w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=750&amp;q=75 750w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=828&amp;q=75 828w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1080&amp;q=75 1080w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1200&amp;q=75 1200w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=1920&amp;q=75 1920w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=2048&amp;q=75 2048w, /_void/image?url=https%3A%2F%2Fimages.example.com%2Flcp.jpg&amp;w=3840&amp;q=75 3840w" imagesizes="100vw" crossorigin="anonymous" referrerpolicy="no-referrer">',
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
    html: '<img alt="LCP" width="800" height="400" decoding="async" data-nimg="1" style="color:transparent" src="/lcp.jpg"/>',
    head: '<link rel="preload" as="image" href="/lcp.jpg">',
  },
  {
    name: 'loading eager (no preload)',
    props: { src: '/a.png', alt: 'A', width: 100, height: 100, loading: 'eager' },
    html: '<img alt="A" loading="eager" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
  },
  {
    name: 'fetchPriority low',
    props: { src: '/a.png', alt: 'A', width: 100, height: 100, fetchPriority: 'low' },
    html: '<img alt="A" fetchpriority="low" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
  },
  {
    name: 'unoptimized',
    props: { src: '/a.png', alt: 'A', width: 100, height: 100, unoptimized: true },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" src="/a.png"/>',
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
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" style="color:transparent" srcset="https://cdn.example.com/a.png?w=128&amp;q=60 1x, https://cdn.example.com/a.png?w=256&amp;q=60 2x" src="https://cdn.example.com/a.png?w=256&amp;q=60"/>',
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
    html: "<img alt=\"Photo\" loading=\"lazy\" width=\"400\" height=\"300\" decoding=\"async\" data-nimg=\"1\" style=\"color:transparent;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'%3E%3Cfilter id='b' color-interpolation-filters='sRGB'%3E%3CfeGaussianBlur stdDeviation='20'/%3E%3CfeColorMatrix values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1' result='s'/%3E%3CfeFlood x='0' y='0' width='100%25' height='100%25'/%3E%3CfeComposite operator='out' in='s'/%3E%3CfeComposite in2='SourceGraphic'/%3E%3CfeGaussianBlur stdDeviation='20'/%3E%3C/filter%3E%3Cimage width='100%25' height='100%25' x='0' y='0' preserveAspectRatio='none' style='filter: url(%23b);' href='data:image/png;base64,iVBORw0KGgo='/%3E%3C/svg%3E&quot;)\" srcset=\"/_void/image?url=%2Fphoto.jpg&amp;w=640&amp;q=75 1x, /_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75 2x\" src=\"/_void/image?url=%2Fphoto.jpg&amp;w=828&amp;q=75\"/>",
  },
  {
    // Solid's server renderer ends a spread `class` with a space.
    name: 'class and string style',
    props: {
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      class: 'rounded shadow',
      style: 'border-radius: 8px; max-width: 100%; height: auto',
    },
    html: '<img alt="A" loading="lazy" width="100" height="100" decoding="async" data-nimg="1" class="rounded shadow " style="color:transparent;border-radius:8px;max-width:100%;height:auto" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
  },
  {
    name: 'static import',
    props: { src: { src: '/assets/hero-abc123.jpg', width: 1600, height: 900 }, alt: 'Hero' },
    html: '<img alt="Hero" loading="lazy" width="1600" height="900" decoding="async" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=1920&amp;q=75 1x, /_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75 2x" src="/_void/image?url=%2Fassets%2Fhero-abc123.jpg&amp;w=3840&amp;q=75"/>',
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
    } as ImageProps,
    html: '<img alt="A" id="avatar" title="Ada" draggable="false" data-testid="avatar" loading="lazy" width="100" height="100" decoding="sync" data-nimg="1" style="color:transparent" srcset="/_void/image?url=%2Fa.png&amp;w=128&amp;q=75 1x, /_void/image?url=%2Fa.png&amp;w=256&amp;q=75 2x" src="/_void/image?url=%2Fa.png&amp;w=256&amp;q=75"/>',
  },
];

describe('Image server rendering', () => {
  it.each(markupCases)('$name', ({ props, html, head }) => {
    const result = renderer.render([props]);
    expect(withoutHydrationKeys(result.html)).toBe(html);
    expect(result.head).toBe(head ?? '');
  });

  it('collects one preload link per srcset', () => {
    const lcp: ImageProps = { src: '/lcp.jpg', alt: 'LCP', width: 800, height: 400, preload: true };
    const result = renderer.render([lcp, { ...lcp, alt: 'Again' }, { ...lcp, sizes: '50vw' }]);

    expect(result.head.match(/<link /g)).toHaveLength(2);
    expect(result.head).toContain('imagesizes="50vw"');
  });

  it('renders preloaded images without a collector', () => {
    const html = renderer.renderWithoutCollector({
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
    });

    expect(withoutHydrationKeys(html)).toBe(
      markupCases.find((item) => item.name === 'priority (deprecated preload)')?.html,
    );
  });
});

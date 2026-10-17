import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { getImageConfig, IMAGE_REGISTRY_KEY } from 'void/image';
import { islandsPlugin } from '../../src/plugin-islands.ts';
import {
  createImageLoadEvent,
  getImageProps,
  parseStyle,
  type ImageProps,
} from '../../src/runtime/image.ts';

// Expected values come from Next.js 16 `getImgProps` results recorded in
// packages/void/test/unit/image-props.golden.ts (case names in comments),
// written with HTML attribute names in `next/image`'s `<img>` order.

const PACKAGE_DIR = join(import.meta.dirname, '../..');
const TMP = join(import.meta.dirname, '__tmp_image__');

/** Svelte's server output captures `load` / `error` before hydration on every `<img>` with a spread. */
const SVELTE_EVENT_CAPTURE: Array<[string, string]> = [
  ['onload', 'this.__e=event'],
  ['onerror', 'this.__e=event'],
];

const BLUR_SVG =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 50'%3E%3Cfilter id='b' color-interpolation-filters='sRGB'%3E%3CfeGaussianBlur stdDeviation='20'/%3E%3CfeColorMatrix values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1' result='s'/%3E%3CfeFlood x='0' y='0' width='100%25' height='100%25'/%3E%3CfeComposite operator='out' in='s'/%3E%3CfeComposite in2='SourceGraphic'/%3E%3CfeGaussianBlur stdDeviation='20'/%3E%3C/filter%3E%3Cimage width='100%25' height='100%25' x='0' y='0' preserveAspectRatio='none' style='filter: url(%23b);' href='data:image/png;base64,YY'/%3E%3C/svg%3E";

const FILL_STYLE =
  'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:cover;color:transparent';

function fillSrcSet(src: string, widths: Array<number>): string {
  return widths.map((w) => `/_void/image?url=${src}&w=${w}&q=75 ${w}w`).join(', ');
}

const IMAGE_SOURCE = join(PACKAGE_DIR, 'src/runtime/Image.svelte');

/** Preloaded `Image`s: the same image three times (once with `priority`) and another image. */
const PRELOAD_PAGE = `<script>
  import Image from ${JSON.stringify(IMAGE_SOURCE)};
  import Island from "./island-wrapper.svelte";
</script>
<Image src="/logo.png" alt="" width={64} height={64} preload />
<Image src="/logo.png" alt="" width={64} height={64} preload />
<Image src="/logo.png" alt="" width={64} height={64} priority />
<Image src="/hero.png" alt="" width={64} height={64} preload />
<Island />
<Island />
`;

const ISLAND_IMAGES = `<script>
  import Image from ${JSON.stringify(IMAGE_SOURCE)};
</script>
<Image src="/logo.png" alt="" width={64} height={64} preload />
<Image src="/logo.png" alt="" width={64} height={64} preload />
`;

let Image: Component<ImageProps>;
let App: Component<Record<string, unknown>>;
let PreloadPage: Component;

/** The island wrapper `plugin-islands` generates for `islandFile`. */
function islandWrapper(islandFile: string): string {
  const plugin = islandsPlugin(join(TMP, 'pages'))[0];
  const load = plugin.load as { handler: (id: string) => string };
  return load.handler(
    `/@void-island-wrap/Island.svelte?src=${encodeURIComponent(islandFile)}&island=Island&hydrate=load`,
  );
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  const islandFile = join(TMP, 'IslandImages.svelte');
  writeFileSync(islandFile, ISLAND_IMAGES);
  writeFileSync(join(TMP, 'island-wrapper.svelte'), islandWrapper(islandFile));
  writeFileSync(join(TMP, 'PreloadPage.svelte'), PRELOAD_PAGE);

  // The unit project has no Svelte plugin: compile the shipped components for
  // the server with Vite, keeping `svelte` and `void` external so the render
  // below shares their instances (and the image config registry).
  const output = (await build({
    root: PACKAGE_DIR,
    configFile: false,
    logLevel: 'silent',
    plugins: [svelte()],
    build: {
      ssr: true,
      write: false,
      rollupOptions: {
        input: {
          Image: IMAGE_SOURCE,
          App: join(PACKAGE_DIR, 'src/runtime/App.svelte'),
          PreloadPage: join(TMP, 'PreloadPage.svelte'),
        },
        external: [/^svelte($|\/)/, /^void($|\/)/],
      },
    },
  })) as Rolldown.RolldownOutput;
  const out = join(TMP, 'out');
  const entries: Record<string, string> = {};
  for (const item of output.output) {
    if (item.type === 'chunk') {
      const file = join(out, item.fileName);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, item.code);
      if (item.isEntry) {
        entries[item.name] = pathToFileURL(file).href;
      }
    }
  }
  const load = async <T>(name: string) => ((await import(entries[name])) as { default: T }).default;
  Image = await load<Component<ImageProps>>('Image');
  App = await load<Component<Record<string, unknown>>>('App');
  PreloadPage = await load<Component>('PreloadPage');
}, 60_000);

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function decode(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** The attributes of every `<tag>` in `html`, in source order, decoded. */
function tags(html: string, tag: string): Array<Array<[string, string]>> {
  const pattern = new RegExp(`<${tag}((?:\\s+[^\\s=/>]+(?:="[^"]*")?)*)\\s*/?>`, 'g');
  return [...html.matchAll(pattern)].map(([, attributes]) =>
    [...attributes.matchAll(/\s+([^\s=/>]+)(?:="([^"]*)")?/g)].map(
      ([, name, value = '']): [string, string] => [name, decode(value)],
    ),
  );
}

function renderImage(props: ImageProps): {
  img: Array<[string, string]>;
  links: Array<Array<[string, string]>>;
} {
  const { body, head } = render(Image, { props });
  const images = tags(body, 'img');
  expect(images).toHaveLength(1);
  // Only the <img> (and Svelte's hydration comments): no text nodes around it.
  expect(body.replaceAll(/<!--.*?-->/g, '')).toMatch(/^<img [^<]*\/>$/);
  return { img: images[0], links: tags(head, 'link') };
}

describe('Image server rendering', () => {
  it('renders the default markup (issue example avatar)', () => {
    const { img, links } = renderImage({
      src: '/avatars/ada.png',
      alt: 'Ada',
      width: 64,
      height: 64,
    });
    expect(img).toEqual([
      ['alt', 'Ada'],
      ['loading', 'lazy'],
      ['width', '64'],
      ['height', '64'],
      ['decoding', 'async'],
      ['data-nimg', '1'],
      ['style', 'color:transparent'],
      [
        'srcset',
        '/_void/image?url=%2Favatars%2Fada.png&w=64&q=75 1x, /_void/image?url=%2Favatars%2Fada.png&w=128&q=75 2x',
      ],
      ['src', '/_void/image?url=%2Favatars%2Fada.png&w=128&q=75'],
      ...SVELTE_EVENT_CAPTURE,
    ]);
    expect(links).toEqual([]);
  });

  it('renders fill images with class and a style string (fill with sizes, className and objectFit)', () => {
    const { img } = renderImage({
      src: 'https://example.com/a.png',
      alt: 'A',
      fill: true,
      sizes: '50vw',
      class: 'c',
      style: 'object-fit: cover',
    });
    expect(img).toEqual([
      ['alt', 'A'],
      ['loading', 'lazy'],
      ['decoding', 'async'],
      ['data-nimg', 'fill'],
      ['class', 'c'],
      ['style', FILL_STYLE],
      ['sizes', '50vw'],
      [
        'srcset',
        fillSrcSet(
          'https%3A%2F%2Fexample.com%2Fa.png',
          [384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
        ),
      ],
      ['src', '/_void/image?url=https%3A%2F%2Fexample.com%2Fa.png&w=3840&q=75'],
      ...SVELTE_EVENT_CAPTURE,
    ]);
  });

  it('accepts a style object like next/image', () => {
    const { img } = renderImage({
      src: 'https://example.com/a.png',
      alt: 'A',
      fill: true,
      sizes: '50vw',
      style: { objectFit: 'cover' },
    });
    expect(img.find(([name]) => name === 'style')).toEqual(['style', FILL_STYLE]);
  });

  it.each([
    ['fetchPriority', { fetchPriority: 'high' }],
    ['fetchpriority', { fetchpriority: 'high' }],
  ] as const)(
    'preloads through svelte:head (preload with fetchPriority high, %s)',
    (_, priority) => {
      const { img, links } = renderImage({
        src: '/a.png',
        alt: 'A',
        width: 10,
        height: 10,
        preload: true,
        ...priority,
      });
      expect(img).toEqual([
        ['alt', 'A'],
        ['fetchpriority', 'high'],
        ['width', '10'],
        ['height', '10'],
        ['decoding', 'async'],
        ['data-nimg', '1'],
        ['style', 'color:transparent'],
        ['srcset', '/_void/image?url=%2Fa.png&w=32&q=75 1x'],
        ['src', '/_void/image?url=%2Fa.png&w=32&q=75'],
        ...SVELTE_EVENT_CAPTURE,
      ]);
      // As in Next.js, `href` is omitted when the image has a `srcset`.
      expect(links).toEqual([
        [
          ['rel', 'preload'],
          ['as', 'image'],
          ['imagesrcset', '/_void/image?url=%2Fa.png&w=32&q=75 1x'],
          ['fetchpriority', 'high'],
        ],
      ]);
    },
  );

  it('preloads unoptimized images by href with CORS attributes (deprecated priority)', () => {
    const { img, links } = renderImage({
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      priority: true,
      unoptimized: true,
      crossorigin: 'anonymous',
      referrerpolicy: 'no-referrer',
    });
    expect(img).toEqual([
      ['alt', 'LCP'],
      ['crossorigin', 'anonymous'],
      ['referrerpolicy', 'no-referrer'],
      ['width', '800'],
      ['height', '400'],
      ['decoding', 'async'],
      ['data-nimg', '1'],
      ['style', 'color:transparent'],
      ['src', '/lcp.jpg'],
      ...SVELTE_EVENT_CAPTURE,
    ]);
    expect(links).toEqual([
      [
        ['rel', 'preload'],
        ['as', 'image'],
        ['href', '/lcp.jpg'],
        ['crossorigin', 'anonymous'],
        ['referrerpolicy', 'no-referrer'],
      ],
    ]);
  });

  it('emits one preload link per image in a page, and per island', () => {
    const { body, head } = render(App, {
      props: {
        page: PreloadPage,
        layouts: [],
        pageProps: {},
        shared: {},
        params: {},
        router: null,
        stores: null,
      },
    });
    expect(tags(body, 'img')).toHaveLength(8);
    const links = tags(head, 'link').map((link) => Object.fromEntries(link).imagesrcset);
    const logo =
      '/_void/image?url=%2Flogo.png&w=64&q=75 1x, /_void/image?url=%2Flogo.png&w=128&q=75 2x';
    const hero =
      '/_void/image?url=%2Fhero.png&w=64&q=75 1x, /_void/image?url=%2Fhero.png&w=128&q=75 2x';
    // Islands hydrate on their own, so each keeps its own links.
    expect(links).toEqual([logo, hero, logo, logo]);
  });

  it('renders the blur placeholder from a style string (blur with objectFit contain)', () => {
    const { img } = renderImage({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 50,
      placeholder: 'blur',
      blurDataURL: 'data:image/png;base64,YY',
      style: 'object-fit: contain',
    });
    expect(img).toEqual([
      ['alt', 'A'],
      ['loading', 'lazy'],
      ['width', '100'],
      ['height', '50'],
      ['decoding', 'async'],
      ['data-nimg', '1'],
      [
        'style',
        `color:transparent;object-fit:contain;background-size:contain;background-position:50% 50%;background-repeat:no-repeat;background-image:url("${BLUR_SVG}")`,
      ],
      [
        'srcset',
        '/_void/image?url=%2Fa.png&w=128&q=75 1x, /_void/image?url=%2Fa.png&w=256&q=75 2x',
      ],
      ['src', '/_void/image?url=%2Fa.png&w=256&q=75'],
      ...SVELTE_EVENT_CAPTURE,
    ]);
  });

  it('keeps other attributes first and ignores srcset and handlers (className and extra attributes)', () => {
    const { img } = renderImage({
      id: 'hero',
      src: '/a.png',
      alt: 'A',
      'data-x': '1',
      width: 100,
      height: 50,
      class: 'img',
      crossorigin: 'anonymous',
      referrerpolicy: 'no-referrer',
      srcset: '/user.png 1x',
      onload: () => {},
      onclick: () => {},
      onLoadingComplete: () => {},
    } as ImageProps);
    expect(img).toEqual([
      ['id', 'hero'],
      ['alt', 'A'],
      ['data-x', '1'],
      ['crossorigin', 'anonymous'],
      ['referrerpolicy', 'no-referrer'],
      ['loading', 'lazy'],
      ['width', '100'],
      ['height', '50'],
      ['decoding', 'async'],
      ['data-nimg', '1'],
      ['class', 'img'],
      ['style', 'color:transparent'],
      [
        'srcset',
        '/_void/image?url=%2Fa.png&w=128&q=75 1x, /_void/image?url=%2Fa.png&w=256&q=75 2x',
      ],
      ['src', '/_void/image?url=%2Fa.png&w=256&q=75'],
      ...SVELTE_EVENT_CAPTURE,
    ]);
  });

  it('reads dimensions from static imports (static import)', () => {
    const { img } = renderImage({
      src: { src: '/assets/a.png', width: 800, height: 600 },
      alt: 'A',
    });
    expect(img.filter(([name]) => ['width', 'height', 'srcset', 'src'].includes(name))).toEqual([
      ['width', '800'],
      ['height', '600'],
      [
        'srcset',
        '/_void/image?url=%2Fassets%2Fa.png&w=828&q=75 1x, /_void/image?url=%2Fassets%2Fa.png&w=1920&q=75 2x',
      ],
      ['src', '/_void/image?url=%2Fassets%2Fa.png&w=1920&q=75'],
    ]);
  });

  it('runs the development checks of the registered config (missing width)', () => {
    const registry = globalThis as Record<PropertyKey, unknown>;
    registry[IMAGE_REGISTRY_KEY] = { config: { ...getImageConfig(), dev: true } };
    try {
      // `render` runs when its output is read.
      expect(() => render(Image, { props: { src: '/a.png', alt: 'A', height: 50 } }).body).toThrow(
        'Image with src "/a.png" is missing required "width" property.',
      );
    } finally {
      delete registry[IMAGE_REGISTRY_KEY];
    }
  });

  it('uses the registered images config (config unoptimized)', () => {
    const registry = globalThis as Record<PropertyKey, unknown>;
    registry[IMAGE_REGISTRY_KEY] = { config: { ...getImageConfig(), unoptimized: true } };
    try {
      const { img } = renderImage({ src: '/a.png', alt: 'A', width: 100, height: 50 });
      expect(img.filter(([name]) => name === 'srcset' || name === 'src')).toEqual([
        ['src', '/a.png'],
      ]);
    } finally {
      delete registry[IMAGE_REGISTRY_KEY];
    }
  });
});

describe('getImageProps', () => {
  it('returns HTML attribute names (getImageProps defaults)', () => {
    const { props } = getImageProps({ src: '/a.png', alt: 'A', width: 100, height: 100 });
    expect(Object.entries(props)).toEqual([
      ['alt', 'A'],
      ['loading', 'lazy'],
      ['width', 100],
      ['height', 100],
      ['decoding', 'async'],
      ['style', 'color:transparent'],
      [
        'srcset',
        '/_void/image?url=%2Fa.png&w=128&q=75 1x, /_void/image?url=%2Fa.png&w=256&q=75 2x',
      ],
      ['src', '/_void/image?url=%2Fa.png&w=256&q=75'],
    ]);
  });

  it('maps class, sizes and fill styles (getImageProps fill)', () => {
    const { props } = getImageProps({
      src: '/a.png',
      alt: 'A',
      fill: true,
      sizes: '50vw',
      class: 'c',
    });
    expect(Object.entries(props)).toEqual([
      ['alt', 'A'],
      ['loading', 'lazy'],
      ['decoding', 'async'],
      ['class', 'c'],
      [
        'style',
        'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent',
      ],
      ['sizes', '50vw'],
      ['srcset', fillSrcSet('%2Fa.png', [384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840])],
      ['src', '/_void/image?url=%2Fa.png&w=3840&q=75'],
    ]);
  });

  it('keeps fetchpriority and drops loading for preloaded images (getImageProps preload)', () => {
    const { props } = getImageProps({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 50,
      preload: true,
      fetchpriority: 'high',
    });
    expect(Object.entries(props)).toEqual([
      ['alt', 'A'],
      ['fetchpriority', 'high'],
      ['width', 100],
      ['height', 50],
      ['decoding', 'async'],
      ['style', 'color:transparent'],
      [
        'srcset',
        '/_void/image?url=%2Fa.png&w=128&q=75 1x, /_void/image?url=%2Fa.png&w=256&q=75 2x',
      ],
      ['src', '/_void/image?url=%2Fa.png&w=256&q=75'],
    ]);
  });

  it('keeps symbol-keyed props such as Svelte attachments', () => {
    const attachment = Symbol('attachment');
    const attach = () => {};
    const { props } = getImageProps({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 50,
      [attachment]: attach,
    } as ImageProps);
    expect((props as Record<symbol, unknown>)[attachment]).toBe(attach);
  });

  it('keeps event handlers other than onload, as next/image keeps onError', () => {
    const onerror = () => {};
    const { props } = getImageProps({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 50,
      onload: () => {},
      onerror,
    });
    expect(props.onerror).toBe(onerror);
    expect('onload' in props).toBe(false);
  });
});

describe('parseStyle', () => {
  it('converts declarations to style object keys', () => {
    expect(
      parseStyle(
        'object-fit: cover; Object-Position: 10% 20%;-webkit-line-clamp:2;-ms-transform: none; --gap: 4px;;',
      ),
    ).toEqual({
      objectFit: 'cover',
      objectPosition: '10% 20%',
      WebkitLineClamp: '2',
      msTransform: 'none',
      '--gap': '4px',
    });
  });

  it('keeps semicolons and colons inside url() and strings', () => {
    expect(
      parseStyle(
        `background-image: url("data:image/png;base64,AA"); content: 'a;b'; mask: url(data:image/svg+xml;utf8,x)`,
      ),
    ).toEqual({
      backgroundImage: 'url("data:image/png;base64,AA")',
      content: "'a;b'",
      mask: 'url(data:image/svg+xml;utf8,x)',
    });
  });

  it('ignores declarations without a name or value', () => {
    expect(parseStyle(': red; color:; color: red !important')).toEqual({
      color: 'red !important',
    });
  });
});

describe('createImageLoadEvent', () => {
  it('creates a load event targeting the image', () => {
    const img = {} as HTMLImageElement;
    const event = createImageLoadEvent(img);
    expect(event.type).toBe('load');
    expect(event.target).toBe(img);
    expect(event.currentTarget).toBe(img);
  });
});

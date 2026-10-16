import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  IMAGE_REGISTRY_KEY,
  type ClientImageConfig,
  type ImageConfigRegistration,
  type ImagePreloadCollector,
} from 'void/image';
import { createRenderer, createSSRApp, defineComponent, h, nextTick, type VNodeChild } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { Image, getImageProps } from '../../src/runtime/image.ts';
import { imageVueGoldenCases } from './image.golden.ts';

type Props = Record<string, unknown>;

async function renderSsr(
  render: () => VNodeChild,
): Promise<{ html: string; preloads: string | undefined }> {
  const context: Record<string, unknown> = {};
  const html = await renderToString(createSSRApp({ render }), context);
  const collector = context.__voidImagePreloads as ImagePreloadCollector | undefined;
  return { html, preloads: collector?.render() };
}

function golden(name: string): (typeof imageVueGoldenCases)[number] {
  const found = imageVueGoldenCases.find((c) => c.name === name);
  if (!found) {
    throw new Error(`Missing golden case "${name}".`);
  }
  return found;
}

function setRegistration(registration: ImageConfigRegistration | undefined): void {
  const store = globalThis as Record<PropertyKey, unknown>;
  if (registration) {
    store[IMAGE_REGISTRY_KEY] = registration;
  } else {
    delete store[IMAGE_REGISTRY_KEY];
  }
}

function clientConfig(overrides: Partial<ClientImageConfig>): ClientImageConfig {
  const deviceSizes = overrides.deviceSizes ?? [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
  const imageSizes = overrides.imageSizes ?? [32, 48, 64, 96, 128, 256, 384];
  return {
    deviceSizes,
    imageSizes,
    allSizes: [...deviceSizes, ...imageSizes].sort((a, b) => a - b),
    qualities: [75],
    path: '/_void/image',
    loader: 'default',
    dangerouslyAllowSVG: false,
    unoptimized: false,
    dev: false,
    ...overrides,
  };
}

afterEach(() => {
  setRegistration(undefined);
  vi.restoreAllMocks();
});

describe('Image server markup parity with next@16.4.2', () => {
  it.each(imageVueGoldenCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { html, preloads } = await renderSsr(() => h(Image, c.props));
    expect(html).toBe(c.html);
    expect(preloads ?? null).toBe(c.preload);
  });
});

describe('Image with Vue attribute forms', () => {
  it('takes class in any Vue form and style as a CSS string', async () => {
    const expected = golden('className and style').html;
    const props = { src: '/a.png', alt: 'A', width: 100, height: 100 };
    const fromString = await renderSsr(() =>
      h(Image, {
        ...props,
        class: ['rounded', { shadow: true, hidden: false }],
        style: 'border-radius: 8px; max-width: 100%; height: auto',
      }),
    );
    const fromArray = await renderSsr(() =>
      h(Image, {
        ...props,
        class: 'rounded shadow',
        style: [{ borderRadius: '8px' }, 'max-width: 100%', { height: 'auto' }],
      }),
    );
    const fromClassName = await renderSsr(() =>
      h(Image, {
        ...props,
        className: 'rounded shadow',
        style: { borderRadius: 8, maxWidth: '100%', height: 'auto' },
      }),
    );
    expect(fromString.html).toBe(expected);
    expect(fromArray.html).toBe(expected);
    expect(fromClassName.html).toBe(expected);
  });

  it('reads object-fit from a style string for the blur placeholder', async () => {
    const c = golden('placeholder blur with objectFit contain');
    const { html } = await renderSsr(() =>
      h(Image, { ...c.props, style: 'object-fit: contain' } as Props),
    );
    expect(html).toBe(c.html);
  });

  it('accepts HTML attribute names for fetchpriority, crossorigin and referrerpolicy', async () => {
    const high = golden('preload with fetchPriority high');
    const { fetchPriority: _fetchPriority, ...highProps } = high.props;
    const highResult = await renderSsr(() =>
      h(Image, { ...highProps, fetchpriority: 'high' } as Props),
    );
    expect(highResult.html).toBe(high.html);
    expect(highResult.preloads).toBe(high.preload);

    const cors = golden('preload fill with crossOrigin and referrerPolicy');
    const { crossOrigin: _crossOrigin, referrerPolicy: _referrerPolicy, ...corsProps } = cors.props;
    const corsResult = await renderSsr(() =>
      h(Image, {
        ...corsProps,
        crossorigin: 'anonymous',
        referrerpolicy: 'no-referrer',
      } as Props),
    );
    expect(corsResult.html).toBe(cors.html);
    expect(corsResult.preloads).toBe(cors.preload);
  });

  it('ignores a user srcset and data-nimg, as next/image does', async () => {
    const c = golden('fixed width (1x/2x)');
    const { html } = await renderSsr(() =>
      h(Image, { ...c.props, srcset: '/user.png 1x', 'data-nimg': 'x' } as Props),
    );
    expect(html).toBe(c.html);
  });

  it('keeps passthrough attributes after alt, ahead of the image attributes', async () => {
    const { html } = await renderSsr(() =>
      h(Image, {
        'data-testid': 'hero',
        src: '/a.png',
        id: 'hero',
        alt: 'A',
        width: 10,
        height: 10,
        unoptimized: true,
        onClick: () => {},
      }),
    );
    expect(html).toBe(
      '<img alt="A" data-testid="hero" id="hero" loading="lazy" width="10" height="10" decoding="async" data-nimg="1" style="color:transparent" src="/a.png">',
    );
  });

  it('takes blurDataURL as blur-data-url or blurDataUrl, the names templates produce', async () => {
    const c = golden('placeholder blur');
    const { blurDataURL, ...props } = c.props;
    for (const name of ['blur-data-url', 'blurDataUrl']) {
      const { html } = await renderSsr(() => h(Image, { ...props, [name]: blurDataURL } as Props));
      expect(html).toBe(c.html);
      expect(
        getImageProps({ ...props, [name]: blurDataURL } as Parameters<typeof getImageProps>[0]),
      ).toEqual(getImageProps(c.props as Parameters<typeof getImageProps>[0]));
    }
    // Development checks see the value instead of reporting it missing.
    setRegistration({ config: clientConfig({ dev: true }) });
    const dev = await renderSsr(() =>
      h(Image, { ...props, 'blur-data-url': blurDataURL } as Props),
    );
    expect(dev.html).toBe(c.html);
  });

  it('treats the Vue boolean shorthand as true', async () => {
    const c = golden('fill');
    const { html } = await renderSsr(() => h(Image, { ...c.props, fill: '' } as Props));
    expect(html).toBe(c.html);
  });
});

describe('Image preload links', () => {
  const lcp = { src: '/lcp.jpg', alt: 'LCP', width: 800, height: 400, preload: true };
  const lcpLink =
    '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x">';

  it('collects one link per image source and leaves the markup unchanged', async () => {
    const { html, preloads } = await renderSsr(() =>
      h('main', [h(Image, lcp), h(Image, { ...lcp, alt: 'LCP again' })]),
    );
    expect(preloads).toBe(lcpLink);
    expect(html).toBe(
      `<main>${golden('preload').html}${golden('preload').html.replace('alt="LCP"', 'alt="LCP again"')}</main>`,
    );
  });

  it('collects links in render order from nested components', async () => {
    const Nested = defineComponent({
      setup: () => () =>
        h('section', [h(Image, { ...lcp, src: '/second.jpg', unoptimized: true })]),
    });
    const { preloads } = await renderSsr(() =>
      h('main', [
        h(Image, lcp),
        h(Nested),
        h(Image, { ...lcp, priority: true, preload: undefined }),
      ]),
    );
    expect(preloads).toBe(`${lcpLink}<link rel="preload" as="image" href="/second.jpg">`);
  });

  it('collects nothing without preload or priority', async () => {
    const { preloads } = await renderSsr(() =>
      h(Image, { ...lcp, preload: false, loading: 'eager', fetchPriority: 'high' }),
    );
    expect(preloads).toBeUndefined();
  });
});

describe('Image reads the registered config and loader', () => {
  it('uses the registered sizes and loaderFile export', async () => {
    setRegistration({
      config: clientConfig({ deviceSizes: [400, 800], imageSizes: [100], path: '/cdn/' }),
      loader: ({ src, width, quality }) => `https://cdn.example.com${src}?w=${width}&q=${quality}`,
    });
    const { html } = await renderSsr(() =>
      h(Image, { src: '/a.png', alt: 'A', width: 90, height: 90, quality: 50 }),
    );
    expect(html).toBe(
      '<img alt="A" loading="lazy" width="90" height="90" decoding="async" data-nimg="1" style="color:transparent" srcset="https://cdn.example.com/a.png?w=100&amp;q=50 1x, https://cdn.example.com/a.png?w=400&amp;q=50 2x" src="https://cdn.example.com/a.png?w=400&amp;q=50">',
    );
  });

  it('throws next/image development errors in development', async () => {
    setRegistration({ config: clientConfig({ dev: true }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      renderSsr(() => h(Image, { src: '/a.png', alt: 'A', height: 10 })),
    ).rejects.toThrow('Image with src "/a.png" is missing required "width" property.');
  });
});

describe('getImageProps', () => {
  it('returns the attributes Image renders, with HTML names and a CSS string', () => {
    expect(
      Object.entries(
        getImageProps({ src: '/avatars/ada.png', alt: 'Ada', width: 64, height: 64 }).props,
      ),
    ).toEqual(
      Object.entries({
        alt: 'Ada',
        loading: 'lazy',
        width: 64,
        height: 64,
        decoding: 'async',
        style: 'color:transparent',
        srcset:
          '/_void/image?url=%2Favatars%2Fada.png&w=64&q=75 1x, /_void/image?url=%2Favatars%2Fada.png&w=128&q=75 2x',
        src: '/_void/image?url=%2Favatars%2Fada.png&w=128&q=75',
      }),
    );
  });

  it('handles fill, sizes, preload, class and unoptimized like next/image', () => {
    expect(
      Object.entries(
        getImageProps({ src: '/cover.jpg', alt: 'Cover', fill: true, sizes: '50vw' }).props,
      ),
    ).toEqual(
      Object.entries({
        alt: 'Cover',
        loading: 'lazy',
        decoding: 'async',
        style:
          'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent',
        sizes: '50vw',
        srcset:
          '/_void/image?url=%2Fcover.jpg&w=384&q=75 384w, /_void/image?url=%2Fcover.jpg&w=640&q=75 640w, /_void/image?url=%2Fcover.jpg&w=750&q=75 750w, /_void/image?url=%2Fcover.jpg&w=828&q=75 828w, /_void/image?url=%2Fcover.jpg&w=1080&q=75 1080w, /_void/image?url=%2Fcover.jpg&w=1200&q=75 1200w, /_void/image?url=%2Fcover.jpg&w=1920&q=75 1920w, /_void/image?url=%2Fcover.jpg&w=2048&q=75 2048w, /_void/image?url=%2Fcover.jpg&w=3840&q=75 3840w',
        src: '/_void/image?url=%2Fcover.jpg&w=3840&q=75',
      }),
    );
    const preloaded = {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
    } as const;
    const expected = Object.entries({
      alt: 'LCP',
      fetchpriority: 'high',
      width: 800,
      height: 400,
      decoding: 'async',
      class: 'hero',
      style: 'color:transparent',
      srcset:
        '/_void/image?url=%2Flcp.jpg&w=828&q=75 1x, /_void/image?url=%2Flcp.jpg&w=1920&q=75 2x',
      src: '/_void/image?url=%2Flcp.jpg&w=1920&q=75',
    });
    expect(
      Object.entries(
        getImageProps({ ...preloaded, fetchPriority: 'high', className: 'hero' }).props,
      ),
    ).toEqual(expected);
    expect(
      Object.entries(
        getImageProps({ ...preloaded, fetchpriority: 'high', class: { hero: true } }).props,
      ),
    ).toEqual(expected);
    expect(
      Object.entries(
        getImageProps({ src: '/a.png', alt: 'A', width: 100, height: 100, unoptimized: true })
          .props,
      ),
    ).toEqual(
      Object.entries({
        alt: 'A',
        loading: 'lazy',
        width: 100,
        height: 100,
        decoding: 'async',
        style: 'color:transparent',
        src: '/a.png',
      }),
    );
  });
});

// A minimal host for Vue's custom renderer, so the browser behavior runs in
// Node: `<img>` elements record attributes, listeners and `src` writes.
type FakeNode = {
  tag: string;
  children: Array<FakeNode>;
  parentElement: FakeNode | null;
  isConnected: boolean;
  attributes: Map<string, string>;
  listeners: Map<string, (event: unknown) => void>;
  complete: boolean;
  srcWrites: number;
  src: string;
  width: number;
  height: number;
  decode(): Promise<void>;
  getAttribute(name: string): string | null;
};

function createNode(tag: string, complete = false): FakeNode {
  let src = '';
  const node: FakeNode = {
    tag,
    children: [],
    parentElement: null,
    isConnected: tag === 'root',
    attributes: new Map(),
    listeners: new Map(),
    complete,
    srcWrites: 0,
    get src() {
      return src;
    },
    set src(value: string) {
      src = value;
      node.srcWrites++;
    },
    width: 0,
    height: 0,
    decode: () => Promise.resolve(),
    getAttribute(name) {
      return node.attributes.get(name) ?? null;
    },
  };
  return node;
}

function setConnected(node: FakeNode, connected: boolean): void {
  node.isConnected = connected;
  for (const child of node.children) {
    setConnected(child, connected);
  }
}

function mountImage(props: Props, options: { complete?: boolean } = {}) {
  const root = createNode('root');
  const { createApp } = createRenderer<FakeNode, FakeNode>({
    createElement: (tag) => createNode(tag, options.complete),
    createText: () => createNode('#text'),
    createComment: () => createNode('#comment'),
    setText: () => {},
    setElementText: () => {},
    insert(child, parent) {
      parent.children.push(child);
      child.parentElement = parent;
      setConnected(child, parent.isConnected);
    },
    remove(child) {
      const parent = child.parentElement;
      if (parent) {
        parent.children.splice(parent.children.indexOf(child), 1);
      }
      child.parentElement = null;
      setConnected(child, false);
    },
    parentNode: (node) => node.parentElement,
    nextSibling: () => null,
    patchProp(el, key, _prev, next) {
      if (/^on[A-Z]/.test(key)) {
        if (typeof next === 'function') {
          el.listeners.set(key, next as (event: unknown) => void);
        } else {
          el.listeners.delete(key);
        }
        return;
      }
      if (next == null) {
        el.attributes.delete(key);
        return;
      }
      el.attributes.set(key, String(next));
      if (key === 'src') {
        el.src = String(next);
      }
    },
  });
  const app = createApp({ render: () => h(Image, props) });
  app.mount(root);
  const img = root.children[0];
  return {
    img,
    fire(name: 'onLoad' | 'onError', event: Record<string, unknown> = {}) {
      img.listeners.get(name)?.({ currentTarget: img, target: img, ...event });
    },
    unmount: () => app.unmount(),
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe('Image in the browser', () => {
  const blurred = {
    src: '/a.png',
    alt: 'A',
    width: 100,
    height: 50,
    placeholder: 'blur',
    blurDataURL: 'data:image/png;base64,YY',
  };

  it('calls @load with a load event once per src after decoding and drops the placeholder', async () => {
    const onLoad = vi.fn();
    const onLoadingComplete = vi.fn();
    const { img, fire } = mountImage({ ...blurred, onLoad, onLoadingComplete });
    expect(img.getAttribute('style')).toContain('background-image:');

    fire('onLoad');
    expect(onLoad).not.toHaveBeenCalled();
    await flush();
    expect(onLoad).toHaveBeenCalledTimes(1);
    const event = onLoad.mock.calls[0][0] as Event;
    expect(event).toBeInstanceOf(Event);
    expect(event.type).toBe('load');
    expect(event.target).toBe(img);
    expect(event.currentTarget).toBe(img);
    expect(onLoadingComplete).toHaveBeenCalledWith(img);
    expect(img.getAttribute('style')).toBe('color:transparent');

    fire('onLoad');
    await flush();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('replays a load that finished before mount', async () => {
    const onLoad = vi.fn();
    const { img } = mountImage({ ...blurred, onLoad }, { complete: true });
    await flush();
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(img.getAttribute('style')).toBe('color:transparent');
  });

  it('skips @load when the image is removed before decoding finishes', async () => {
    const onLoad = vi.fn();
    const { fire, unmount } = mountImage({ ...blurred, onLoad });
    fire('onLoad');
    unmount();
    await flush();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('shows the alt text and drops the placeholder on error, then calls @error', async () => {
    const onError = vi.fn();
    const { img, fire } = mountImage({ ...blurred, onError });
    fire('onError', { type: 'error' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    await nextTick();
    expect(img.getAttribute('style')).toBeNull();
  });

  it('retries the request on mount only when @error is set, so an early error is not lost', () => {
    expect(mountImage(blurred).img.srcWrites).toBe(1);
    const { img } = mountImage({ ...blurred, onError: () => {} });
    expect(img.srcWrites).toBe(2);
    expect(img.src).toBe('/_void/image?url=%2Fa.png&w=256&q=75');
  });

  it('passes other listeners to the img and renders without an SSR context', () => {
    const onClick = vi.fn();
    const { img } = mountImage({ ...blurred, preload: true, onClick });
    expect(img.listeners.has('onClick')).toBe(true);
    img.listeners.get('onClick')?.({});
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(img.getAttribute('data-nimg')).toBe('1');
    expect([...img.attributes.keys()].at(-1)).toBe('src');
  });
});

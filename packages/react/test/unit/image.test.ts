import { createElement, createRef, type ReactElement } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getImageConfig, IMAGE_REGISTRY_KEY, type ClientImageConfig } from 'void/image';
import packageJson from '../../package.json' with { type: 'json' };
import * as imageModule from '../../src/image.ts';
import { getImageProps, Image, type ImageProps } from '../../src/runtime/image.tsx';
import * as runtime from '../../src/runtime/index.ts';
import { renderReactPage } from '../../src/runtime/pages-server.ts';
import {
  imageGoldenCases,
  imageGoldenDedupeTree,
  imageGoldenGetImageProps,
} from './image.golden.ts';

const registry = globalThis as Record<PropertyKey, unknown>;

function registerImageConfig(config: Partial<ClientImageConfig>, loader?: unknown): void {
  registry[IMAGE_REGISTRY_KEY] = { config: { ...getImageConfig(), ...config }, loader };
}

afterEach(() => {
  delete registry[IMAGE_REGISTRY_KEY];
  vi.restoreAllMocks();
});

type ImgElementProps = {
  onLoad: (event: { currentTarget: unknown }) => void;
  onError: (event: unknown) => void;
};

/**
 * The `<img>` element `Image` renders, with its React event handlers, and
 * spies for the component's `blurComplete` / `showAltText` setters. Renders
 * on the server, since this package's unit tests have no DOM.
 */
function renderImgElement(props: ImageProps): {
  img: ReactElement<ImgElementProps>;
  setBlurComplete: ReturnType<typeof vi.fn>;
  setShowAltText: ReturnType<typeof vi.fn>;
} {
  let fragment: ReactElement<{ children: Array<ReactElement> }> | undefined;
  renderToStaticMarkup(
    createElement(function ImageProbe() {
      fragment = Image(props) as ReactElement<{ children: Array<ReactElement> }>;
      return null;
    }),
  );
  const imageElement = fragment!.props.children[0] as ReactElement<Record<string, unknown>>;
  const setBlurComplete = vi.fn();
  const setShowAltText = vi.fn();
  let img: ReactElement<ImgElementProps> | undefined;
  renderToStaticMarkup(
    createElement(function ImageElementProbe() {
      const render = imageElement.type as (props: Record<string, unknown>) => ReactElement;
      img = render({
        ...imageElement.props,
        setBlurComplete,
        setShowAltText,
      }) as ReactElement<ImgElementProps>;
      return null;
    }),
  );
  return { img: img!, setBlurComplete, setShowAltText };
}

function fakeImg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    src: 'http://localhost/_void/image?url=%2Fa.png&w=256&q=75',
    isConnected: true,
    parentElement: {},
    width: 100,
    height: 100,
    complete: true,
    decode: () => Promise.resolve(),
    getAttribute: (name: string) => (name === 'data-nimg' ? '1' : '100'),
    ...overrides,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Image matches next/image 16.4.2 markup', () => {
  it.each(imageGoldenCases)('$name', ({ props, staticMarkup, tree }) => {
    expect(renderToStaticMarkup(createElement(Image, props))).toBe(staticMarkup);
    expect(renderToString(createElement('main', null, createElement(Image, props)))).toBe(tree);
  });

  it('emits one preload link for two preloaded images with the same source', () => {
    const props: ImageProps = {
      src: '/lcp.jpg',
      alt: 'LCP',
      width: 800,
      height: 400,
      preload: true,
    };
    expect(
      renderToString(
        createElement(
          'main',
          null,
          createElement(Image, props),
          createElement(Image, { ...props, alt: 'LCP again' }),
        ),
      ),
    ).toBe(imageGoldenDedupeTree);
  });
});

describe('getImageProps', () => {
  it.each(imageGoldenGetImageProps)('matches next/image 16.4.2: $name', ({ props, result }) => {
    const { props: imgProps } = getImageProps(props);
    expect(imgProps).toStrictEqual(result);
    expect(Object.keys(imgProps)).toEqual(Object.keys(result));
  });

  it('removes keys whose value is undefined', () => {
    const { props } = getImageProps({ src: '/a.png', alt: 'A', width: 100, height: 100 });
    expect(Object.entries(props).filter(([, value]) => value === undefined)).toEqual([]);
    expect(props).not.toHaveProperty('fetchPriority');
    expect(props).not.toHaveProperty('className');
    expect(props).not.toHaveProperty('sizes');
  });

  it('does not preload', () => {
    const markup = renderToString(
      createElement(function Page() {
        getImageProps({ src: '/lcp.jpg', alt: 'LCP', width: 800, height: 400, preload: true });
        return null;
      }),
    );
    expect(markup).toBe('');
  });
});

describe('Image config', () => {
  it('uses the registered images config and loader file', () => {
    registerImageConfig(
      { deviceSizes: [400, 800], imageSizes: [100], allSizes: [100, 400, 800] },
      ({ src, width, quality }: { src: string; width: number; quality?: number }) =>
        `https://cdn.example.com${src}?w=${width}&q=${quality ?? 'auto'}`,
    );
    expect(
      renderToStaticMarkup(
        createElement(Image, { src: '/a.png', alt: 'A', width: 90, height: 90 }),
      ),
    ).toBe(
      '<img alt="A" loading="lazy" width="90" height="90" decoding="async" data-nimg="1" style="color:transparent" srcSet="https://cdn.example.com/a.png?w=100&amp;q=auto 1x, https://cdn.example.com/a.png?w=400&amp;q=auto 2x" src="https://cdn.example.com/a.png?w=400&amp;q=auto"/>',
    );
  });

  it('does not pass ref to the shared props (no unsupported ref warning)', () => {
    registerImageConfig({ dev: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const markup = renderToStaticMarkup(
      createElement(Image, {
        src: '/ref.png',
        alt: 'Ref',
        width: 100,
        height: 100,
        ref: createRef<HTMLImageElement>(),
      }),
    );
    expect(markup).not.toContain(' ref=');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('throws the development errors of next/image', () => {
    registerImageConfig({ dev: true });
    expect(() =>
      renderToStaticMarkup(createElement(Image, { src: '/a.png', alt: 'A', width: 100 })),
    ).toThrow('Image with src "/a.png" is missing required "height" property.');
  });
});

describe('Image events', () => {
  it('calls onLoad with a load event and onLoadingComplete once per src, then ends the blur', async () => {
    const onLoad = vi.fn();
    const onLoadingComplete = vi.fn();
    const { img, setBlurComplete } = renderImgElement({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      placeholder: 'blur',
      blurDataURL: 'data:image/png;base64,iVBORw0KGgo=',
      onLoad,
      onLoadingComplete,
    });
    const element = fakeImg();

    img.props.onLoad({ currentTarget: element });
    img.props.onLoad({ currentTarget: element });
    await flush();

    expect(setBlurComplete).toHaveBeenCalledExactlyOnceWith(true);
    expect(onLoad).toHaveBeenCalledOnce();
    const event = onLoad.mock.calls[0][0];
    expect(event.target).toBe(element);
    expect(event.currentTarget).toBe(element);
    expect(event.nativeEvent).toBeInstanceOf(Event);
    expect(event.nativeEvent.type).toBe('load');
    expect(event.isDefaultPrevented()).toBe(false);
    event.preventDefault();
    expect(event.isDefaultPrevented()).toBe(true);
    expect(onLoadingComplete).toHaveBeenCalledExactlyOnceWith(element);
    expect(onLoad.mock.invocationCallOrder[0]).toBeLessThan(
      onLoadingComplete.mock.invocationCallOrder[0],
    );
  });

  it('keeps the placeholder state for placeholder="empty"', async () => {
    const onLoad = vi.fn();
    const { img, setBlurComplete } = renderImgElement({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      onLoad,
    });
    img.props.onLoad({ currentTarget: fakeImg() });
    await flush();
    expect(setBlurComplete).not.toHaveBeenCalled();
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it('skips callbacks when the image was removed before decoding finished', async () => {
    const onLoad = vi.fn();
    const onLoadingComplete = vi.fn();
    const { img } = renderImgElement({
      src: '/a.png',
      alt: 'A',
      width: 100,
      height: 100,
      onLoad,
      onLoadingComplete,
    });
    img.props.onLoad({ currentTarget: fakeImg({ isConnected: false }) });
    await flush();
    expect(onLoad).not.toHaveBeenCalled();
    expect(onLoadingComplete).not.toHaveBeenCalled();
  });

  it('shows the alt text, ends the blur and calls onError when loading fails', () => {
    const onError = vi.fn();
    const { img, setBlurComplete, setShowAltText } = renderImgElement({
      src: '/missing.png',
      alt: 'Missing',
      width: 100,
      height: 100,
      placeholder: 'data:image/png;base64,iVBORw0KGgo=',
      onError,
    });
    const event = { currentTarget: fakeImg() };
    img.props.onError(event);
    expect(setShowAltText).toHaveBeenCalledExactlyOnceWith(true);
    expect(setBlurComplete).toHaveBeenCalledExactlyOnceWith(true);
    expect(onError).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('only shows the alt text on error without a placeholder', () => {
    const { img, setBlurComplete, setShowAltText } = renderImgElement({
      src: '/missing.png',
      alt: 'Missing',
      width: 100,
      height: 100,
    });
    img.props.onError({ currentTarget: fakeImg() });
    expect(setShowAltText).toHaveBeenCalledExactlyOnceWith(true);
    expect(setBlurComplete).not.toHaveBeenCalled();
  });
});

describe('page rendering', () => {
  it('puts one preload link at the top of the app root', async () => {
    function Page() {
      return createElement(
        'main',
        null,
        createElement(Image, {
          src: '/lcp.jpg',
          alt: 'LCP',
          width: 800,
          height: 400,
          preload: true,
        }),
        createElement(Image, {
          src: '/lcp.jpg',
          alt: 'LCP again',
          width: 800,
          height: 400,
          preload: true,
        }),
        createElement(Image, { src: '/below.jpg', alt: 'Below', width: 800, height: 400 }),
      );
    }
    const stream = await renderReactPage({
      pageObj: { component: 'page', props: {}, url: '/', params: {}, shared: {}, errors: null },
      assetTags: { css: '', preloads: '', body: '' },
      components: { page: async () => ({ default: Page }) },
      layoutTree: {},
    });
    const html = await new Response(stream).text();
    const app = html.slice(html.indexOf('<div id="app">'));

    expect(app.startsWith('<div id="app"><link rel="preload" as="image" imageSrcSet="')).toBe(true);
    expect(html.match(/<link rel="preload" as="image"/g)).toHaveLength(1);
    expect(app).toContain('<img alt="Below" loading="lazy"');
  });
});

describe('@void/react/image', () => {
  it('has the next/image module shape', () => {
    expect(Object.keys(imageModule).sort()).toEqual(['Image', 'default', 'getImageProps']);
    expect(imageModule.default).toBe(Image);
    expect(imageModule.Image).toBe(Image);
    expect(imageModule.getImageProps).toBe(getImageProps);
  });

  it('is exported from @void/react and the ./image subpath', () => {
    expect(runtime.Image).toBe(Image);
    expect(runtime.getImageProps).toBe(getImageProps);
    expect(packageJson.exports['./image']).toEqual({
      types: './dist/image.d.mts',
      import: './dist/image.mjs',
    });
  });
});

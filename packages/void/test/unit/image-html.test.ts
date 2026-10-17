import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createImagePreloadCollector,
  getImagePreloadLink,
  getImgProps,
  defaultLoader,
  getImageConfig,
  handleImageLoading,
  renderImagePreloadLinks,
  styleToString,
  toHtmlImgAttributes,
  type ImageElementLike,
  type ImgPropsResult,
} from '../../src/image/index.ts';

function props(input: Record<string, unknown> & { src: string; alt: string }): ImgPropsResult {
  return getImgProps(input, { defaultLoader, imgConf: getImageConfig() });
}

describe('styleToString', () => {
  it('serializes styles as React DOM does', () => {
    // React 19 renderToStaticMarkup output for Next.js's fill style.
    expect(
      styleToString({
        position: 'absolute',
        height: '100%',
        width: '100%',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        objectFit: 'cover',
        objectPosition: undefined,
        color: 'transparent',
      }),
    ).toBe(
      'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:cover;color:transparent',
    );
  });

  it('adds px to unit properties, keeps unitless numbers and custom properties', () => {
    expect(
      styleToString({
        borderRadius: 8,
        opacity: 0.5,
        zIndex: 2,
        msTransform: 'none',
        WebkitLineClamp: 2,
        '--accent': ' red ',
        margin: '',
      }),
    ).toBe(
      'border-radius:8px;opacity:0.5;z-index:2;-ms-transform:none;-webkit-line-clamp:2;--accent:red',
    );
    expect(styleToString({})).toBe('');
  });
});

describe('toHtmlImgAttributes', () => {
  it('converts getImgProps output to HTML attributes in order', () => {
    const { props: imgProps } = props({
      src: '/a.png',
      alt: 'A',
      width: 64,
      height: 64,
      className: 'avatar',
      crossOrigin: 'anonymous',
      referrerPolicy: 'no-referrer',
      fetchPriority: 'high',
      onError: () => {},
    });
    const attributes = toHtmlImgAttributes(imgProps);
    expect(Object.keys(attributes)).toEqual([
      'alt',
      'crossorigin',
      'referrerpolicy',
      'loading',
      'fetchpriority',
      'width',
      'height',
      'decoding',
      'class',
      'style',
      'srcset',
      'src',
    ]);
    expect(attributes).toMatchObject({
      class: 'avatar',
      style: 'color:transparent',
      srcset: '/_void/image?url=%2Fa.png&w=64&q=75 1x, /_void/image?url=%2Fa.png&w=128&q=75 2x',
      src: '/_void/image?url=%2Fa.png&w=128&q=75',
    });
  });

  it('drops undefined values and empty styles', () => {
    const { props: imgProps } = props({
      src: 'data:image/png;base64,AA',
      alt: '',
      width: 1,
      height: 1,
    });
    expect(toHtmlImgAttributes({ ...imgProps, style: {} })).toEqual({
      alt: '',
      width: 1,
      height: 1,
      decoding: 'async',
      src: 'data:image/png;base64,AA',
    });
  });
});

describe('image preload links', () => {
  it('returns nothing unless the image is preloaded', () => {
    const { props: imgProps, meta } = props({ src: '/a.png', alt: '', width: 10, height: 10 });
    expect(getImagePreloadLink(imgProps, meta)).toBeUndefined();
  });

  it('omits href when the image has a srcset', () => {
    const { props: imgProps, meta } = props({
      src: '/a.png',
      alt: '',
      fill: true,
      sizes: '50vw',
      preload: true,
      fetchPriority: 'high',
      crossOrigin: 'use-credentials',
    });
    const link = getImagePreloadLink(imgProps, meta);
    expect(link).toEqual({
      key: `${imgProps.srcSet}\n50vw`,
      imagesrcset: imgProps.srcSet,
      imagesizes: '50vw',
      crossorigin: 'use-credentials',
      fetchpriority: 'high',
    });
  });

  it('uses href for unoptimized images and dedupes by key', () => {
    const { props: imgProps, meta } = props({
      src: '/a.png?x=1&y="2"',
      alt: '',
      width: 10,
      height: 10,
      priority: true,
      unoptimized: true,
    });
    const link = getImagePreloadLink(imgProps, meta)!;
    expect(link).toEqual({ key: '/a.png?x=1&y="2"', href: '/a.png?x=1&y="2"' });

    const collector = createImagePreloadCollector();
    collector.add(link);
    collector.add({ ...link });
    expect(collector.links()).toHaveLength(1);
    expect(collector.render()).toBe(
      '<link rel="preload" as="image" href="/a.png?x=1&amp;y=&quot;2&quot;">',
    );
  });

  it.each([
    ['crossOrigin: ""', { crossOrigin: '' }],
    ['crossorigin: ""', { crossorigin: '' }],
    ['a bare crossorigin attribute', { crossorigin: true }],
  ])('keeps the anonymous CORS mode of %s', (_name, cors) => {
    const { props: imgProps, meta } = props({
      src: '/a.png',
      alt: '',
      width: 10,
      height: 10,
      preload: true,
      ...cors,
    });
    const link = getImagePreloadLink(imgProps, meta)!;
    expect(link.crossorigin).toBe('');
    expect(renderImagePreloadLinks([link])).toContain(' crossorigin=""');
    expect(toHtmlImgAttributes(imgProps)).toHaveProperty('crossorigin');
  });

  it('leaves out crossorigin: false', () => {
    const { props: imgProps, meta } = props({
      src: '/a.png',
      alt: '',
      width: 10,
      height: 10,
      preload: true,
      crossorigin: false,
    });
    expect(getImagePreloadLink(imgProps, meta)).not.toHaveProperty('crossorigin');
  });

  it('renders every attribute', () => {
    expect(
      renderImagePreloadLinks([
        {
          key: 'k',
          imagesrcset: '/a 1x, /b 2x',
          imagesizes: '100vw',
          crossorigin: 'anonymous',
          referrerpolicy: 'no-referrer',
          fetchpriority: 'high',
        },
      ]),
    ).toBe(
      '<link rel="preload" as="image" imagesrcset="/a 1x, /b 2x" imagesizes="100vw" crossorigin="anonymous" referrerpolicy="no-referrer" fetchpriority="high">',
    );
  });
});

type FakeImage = ImageElementLike & { attributes: Record<string, string> };

function fakeImage(overrides: Partial<FakeImage> = {}): FakeImage {
  const attributes: Record<string, string> = { width: '10', height: '10' };
  return {
    src: 'http://localhost/_void/image?url=%2Fa.png&w=32&q=75',
    isConnected: true,
    parentElement: {},
    width: 10,
    height: 10,
    attributes,
    decode: () => Promise.resolve(),
    getAttribute: (name: string) => attributes[name] ?? null,
    ...overrides,
  };
}

describe('handleImageLoading', () => {
  it('ends the placeholder and calls onLoad once per src after decoding', async () => {
    const img = fakeImage();
    const calls: Array<string> = [];
    const options = {
      placeholder: 'blur' as const,
      onBlurComplete: () => calls.push('blur'),
      onLoad: (loaded: FakeImage) => calls.push(`load:${loaded === img}`),
    };
    handleImageLoading(img, options);
    handleImageLoading(img, options);
    expect(calls).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['blur', 'load:true']);

    (img as { src: string }).src = 'http://localhost/b.png';
    handleImageLoading(img, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['blur', 'load:true', 'blur', 'load:true']);
  });

  it('skips images removed before decoding finished and tolerates decode errors', async () => {
    const onLoad = vi.fn();
    const removed = fakeImage({ isConnected: false });
    handleImageLoading(removed, { placeholder: 'empty', onLoad });
    const failing = fakeImage({ decode: () => Promise.reject(new Error('decode')) });
    handleImageLoading(failing, { placeholder: 'empty', onLoad });
    handleImageLoading(null, { placeholder: 'empty', onLoad });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith(failing);
  });

  it('warns in development when only one dimension was changed by CSS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const img = fakeImage({ width: 20 });
    handleImageLoading(img, { placeholder: 'empty', dev: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith(
      `Image with src "/a.png" has either width or height modified, but not the other. If you use CSS to change the size of your image, also include the styles 'width: "auto"' or 'height: "auto"' to maintain the aspect ratio.`,
    );
    warn.mockRestore();
  });
});

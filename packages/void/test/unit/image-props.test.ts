import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveImageConfig, toClientImageConfig } from '../../src/image-config.ts';
import {
  IMAGE_DOCS_URL,
  IMAGE_REGISTRY_KEY,
  cloudflareLoader,
  defaultLoader,
  getDefaultImageLoader,
  getImageConfig,
  getImageProps,
  getImgProps,
  resolveImageProps,
  type ClientImageConfig,
  type ImageConfigRegistration,
  type ImageLoader,
  type ImageLoaderWithConfig,
} from '../../src/image/index.ts';
import {
  imagePropsDevGolden,
  imagePropsGolden,
  type ImagePropsGoldenCase,
} from './image-props.golden.ts';

const FN = '[function]';

// The loaders the golden cases name (same bodies as in the generator).
const loaders: Record<string, ImageLoader> = {
  query: ({ src, width, quality }) => `${src}?w=${width}&q=${quality}`,
  identity: ({ src }) => src,
  absoluteIdentity: ({ src }) => `https://cdn.example.com${src}`,
  cdn: ({ src, width, quality }) =>
    `https://cdn.example.com${src}?width=${width}&quality=${quality || 75}`,
};

/** Next.js messages with Void's product names and documentation link. */
function adaptNextMessage(message: string): string {
  return message
    .replaceAll('next.config.js', 'void.config.ts')
    .replaceAll('`next/image`', '`Image`')
    .replaceAll('Next Image Optimization', 'Void Image Optimization')
    .replace(/https:\/\/nextjs\.org\/docs\/\S+/g, IMAGE_DOCS_URL);
}

function materialize(value: unknown): unknown {
  if (value === FN) {
    return () => {};
  }
  if (Array.isArray(value)) {
    return value.map(materialize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v)]));
  }
  return value;
}

function configFor(c: ImagePropsGoldenCase, dev: boolean): ClientImageConfig {
  const resolved = resolveImageConfig(c.config, { root: import.meta.dirname, dev });
  return toClientImageConfig(resolved, c.consumer ?? 'server');
}

function setRegistration(registration: ImageConfigRegistration | undefined): void {
  const store = globalThis as Record<PropertyKey, unknown>;
  if (registration) {
    store[IMAGE_REGISTRY_KEY] = registration;
  } else {
    delete store[IMAGE_REGISTRY_KEY];
  }
}

function run(c: ImagePropsGoldenCase, dev: boolean): unknown {
  const props = materialize(c.props) as Record<string, unknown> & { src: string; alt: string };
  if (c.loader) {
    props.loader = loaders[c.loader];
  }
  const imgConf = configFor(c, dev);
  if (c.api === 'getImageProps') {
    setRegistration({ config: imgConf });
    try {
      return getImageProps(props);
    } finally {
      setRegistration(undefined);
    }
  }
  const loader: ImageLoaderWithConfig | undefined =
    c.defaultLoader === 'missing'
      ? undefined
      : c.defaultLoader
        ? loaders[c.defaultLoader]
        : defaultLoader;
  return getImgProps(props, { defaultLoader: loader, imgConf, ...c.state });
}

function expectGolden(c: ImagePropsGoldenCase, dev: boolean): void {
  if (c.expected.error !== undefined) {
    let message: string | undefined;
    try {
      run(c, dev);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(adaptNextMessage(c.expected.error));
    return;
  }
  const actual = run(c, dev) as { props: Record<string, unknown>; meta?: Record<string, unknown> };
  expect(actual).toStrictEqual(c.expected);
  // Attribute order matters (`src` last), so compare key order too.
  expect(Object.keys(actual.props)).toEqual(Object.keys(c.expected.props!));
  expect(Object.keys(actual.props.style as object)).toEqual(
    Object.keys(c.expected.props!.style as object),
  );
  if (c.expected.meta) {
    expect(Object.keys(actual.meta!)).toEqual(Object.keys(c.expected.meta));
  }
}

describe('getImgProps parity with next@16.4.2 (production)', () => {
  it.each(imagePropsGolden.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expectGolden(c, false);
  });
});

describe('getImgProps parity with next@16.4.2 (development)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(imagePropsDevGolden.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expectGolden(c, true);
    expect(warn.mock.calls.map(([message]) => message)).toEqual(c.warnings.map(adaptNextMessage));
  });
});

describe('registry-aware entry points', () => {
  afterEach(() => {
    setRegistration(undefined);
  });

  it('falls back to Next.js defaults without patterns when nothing is registered', () => {
    expect(getImageConfig()).toEqual({
      deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
      imageSizes: [32, 48, 64, 96, 128, 256, 384],
      allSizes: [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
      qualities: [75],
      path: '/_void/image',
      loader: 'default',
      dangerouslyAllowSVG: false,
      unoptimized: false,
      dev: false,
    });
    // Without patterns the query-string check does not apply (Next.js client behavior).
    expect(getImageProps({ src: '/a.png?v=1', alt: '', width: 10, height: 10 }).props.src).toBe(
      '/_void/image?url=%2Fa.png%3Fv%3D1&w=32&q=75',
    );
  });

  it('getImageProps deletes undefined keys and reads the registered config', () => {
    const config = toClientImageConfig(
      resolveImageConfig({ qualities: [40, 90], path: '/img' }, { root: '/', dev: false }),
      'server',
    );
    setRegistration({ config });
    const { props } = getImageProps({ src: '/a.png', alt: 'A', width: 64, height: 64 });
    expect(props).toStrictEqual({
      alt: 'A',
      loading: 'lazy',
      width: 64,
      height: 64,
      decoding: 'async',
      style: { color: 'transparent' },
      srcSet: '/img?url=%2Fa.png&w=64&q=90 1x, /img?url=%2Fa.png&w=128&q=90 2x',
      src: '/img?url=%2Fa.png&w=128&q=90',
    });
    expect(props).not.toHaveProperty('meta');
  });

  it('getImageProps sees patterns only in development, as Next.js inlines them', () => {
    const query = { src: '/a.png?v=1', alt: '', width: 10, height: 10 };
    const register = (dev: boolean) =>
      setRegistration({
        config: toClientImageConfig(resolveImageConfig(undefined, { root: '/', dev }), 'server'),
      });
    register(false);
    expect(getImageProps(query).props.src).toBe('/_void/image?url=%2Fa.png%3Fv%3D1&w=32&q=75');
    // `Image` reads the full server config, as Next.js's image config context does.
    expect(() => resolveImageProps(query)).toThrow('is using a query string');
    register(true);
    expect(() => getImageProps(query)).toThrow('is using a query string');
  });

  it('uses the registered loaderFile export as the default loader', () => {
    const config = toClientImageConfig(
      resolveImageConfig(undefined, { root: '/', dev: false }),
      'server',
    );
    const loader: ImageLoader = ({ src, width }) => `https://cdn.example.com${src}?w=${width}`;
    setRegistration({ config, loader });
    expect(getDefaultImageLoader()).toBe(loader);
    const { props } = resolveImageProps({ src: '/a.png', alt: '', width: 10, height: 10 });
    expect(props.src).toBe('https://cdn.example.com/a.png?w=32');
  });

  it('reports a loaderFile without a default export instead of falling back', () => {
    const config = toClientImageConfig(
      resolveImageConfig(undefined, { root: '/', dev: false }),
      'server',
    );
    const props = { src: '/a.png', alt: '', width: 10, height: 10 };
    setRegistration({ config, loader: undefined, hasLoaderFile: true });
    expect(getDefaultImageLoader()).toBeUndefined();
    expect(() => getImageProps(props)).toThrow(
      'images.loaderFile detected but the file is missing default export.',
    );
    expect(() => resolveImageProps(props)).toThrow(
      'images.loaderFile detected but the file is missing default export.',
    );
    // A default export that isn't a function fails like Next.js, not with /_void/image URLs.
    setRegistration({ config, loader: {} as ImageLoader, hasLoaderFile: true });
    expect(() => getImageProps(props)).toThrow(TypeError);
  });

  it('picks the Cloudflare loader for loader: "cloudflare"', () => {
    const config = toClientImageConfig(
      resolveImageConfig({ loader: 'cloudflare' }, { root: '/', dev: false }),
      'server',
    );
    setRegistration({ config, loader: undefined });
    expect(getDefaultImageLoader()).toBe(cloudflareLoader);
    const { props, meta } = resolveImageProps({ src: '/a.png', alt: '', width: 10, height: 10 });
    expect(props.srcSet).toBe('/cdn-cgi/image/width=32,quality=75,format=auto/a.png 1x');
    expect(meta.unoptimized).toBe(false);
    // Built-in loaders keep Next.js's SVG rule.
    expect(resolveImageProps({ src: '/a.svg', alt: '', width: 10, height: 10 }).props.src).toBe(
      '/a.svg',
    );
  });

  it('defaults to the default loader for an explicit config', () => {
    expect(getDefaultImageLoader({ ...getImageConfig(), loader: 'default' })).toBe(defaultLoader);
  });

  it.each([
    ['a node target', { target: 'node' }],
    ['static output', { output: 'static' as const }],
    ['a Void Platform build', { managed: true }],
  ])('keeps loader props on %s, which has no optimizer', (_name, options) => {
    const config = toClientImageConfig(
      resolveImageConfig(undefined, { root: '/', dev: false, ...options }),
      'client',
    );
    setRegistration({ config });
    const props = { src: '/a.png', alt: '', width: 100, height: 100 };
    const loader: ImageLoader = ({ src, width, quality }) =>
      `https://cdn.example.com${src}?w=${width}&q=${quality ?? 75}`;

    const withLoader = resolveImageProps({ ...props, loader });
    expect(withLoader.props.srcSet).toBe(
      'https://cdn.example.com/a.png?w=128&q=75 1x, https://cdn.example.com/a.png?w=256&q=75 2x',
    );
    expect(withLoader.meta.unoptimized).toBe(false);
    expect(getImageProps({ ...props, loader }).props.src).toBe(
      'https://cdn.example.com/a.png?w=256&q=75',
    );

    // Without a loader prop there is no endpoint to send the image to.
    const plain = resolveImageProps(props);
    expect(plain.props.src).toBe('/a.png');
    expect(plain.props.srcSet).toBeUndefined();
    expect(plain.meta.unoptimized).toBe(true);
  });

  it('resolveImageProps applies component state', () => {
    const base = { src: '/a.png', alt: '', width: 100, height: 50, placeholder: 'blur' as const };
    const blurDataURL = 'data:image/png;base64,AA';
    expect(resolveImageProps({ ...base, blurDataURL }).props.style).toHaveProperty(
      'backgroundImage',
    );
    expect(
      resolveImageProps({ ...base, blurDataURL }, { blurComplete: true, showAltText: true }).props
        .style,
    ).toEqual({});
  });
});

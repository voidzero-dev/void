import { describe, expect, it } from 'vite-plus/test';
import { resolveImageConfig, toClientImageConfig } from '../../src/image-config.ts';
import {
  IMAGE_DOCS_URL,
  cloudflareLoader,
  defaultLoader,
  findClosestQuality,
  getImageBlurSvg,
  getImgProps,
  type ClientImageConfig,
  type ImageConfig,
} from '../../src/image/index.ts';

function clientConfig(
  images: ImageConfig | undefined,
  options: { dev?: boolean; consumer?: 'client' | 'server' } = {},
): ClientImageConfig {
  return toClientImageConfig(
    resolveImageConfig(images, { root: import.meta.dirname, dev: options.dev ?? false }),
    options.consumer ?? 'server',
  );
}

describe('findClosestQuality', () => {
  it.each([
    [undefined, [75], 75],
    [90, [75], 75],
    [undefined, [50, 90], 90],
    [83, [50, 75, 90], 90],
    [82, [50, 75, 90], 75],
    [70, [60, 80], 60],
    [100, [1, 100], 100],
    [0, [50, 75], 75],
  ] as Array<[number | undefined, Array<number>, number]>)(
    'quality %s with %j is %s',
    (quality, qualities, expected) => {
      expect(findClosestQuality(quality, { qualities })).toBe(expected);
    },
  );

  it('returns the requested quality without qualities', () => {
    expect(findClosestQuality(42, {})).toBe(42);
    expect(findClosestQuality(undefined, undefined)).toBe(75);
    expect(findClosestQuality(42, { qualities: [] })).toBe(42);
  });
});

describe('defaultLoader', () => {
  const config = clientConfig(undefined);

  it('builds /_void/image URLs with the closest configured quality', () => {
    expect(defaultLoader({ config, src: '/a b.png', width: 640, quality: 90 })).toBe(
      '/_void/image?url=%2Fa%20b.png&w=640&q=75',
    );
    expect(
      defaultLoader({ config, src: 'https://example.com/a.jpg?x=1', width: 32, quality: 75 }),
    ).toBe('/_void/image?url=https%3A%2F%2Fexample.com%2Fa.jpg%3Fx%3D1&w=32&q=75');
    expect(defaultLoader.__void_img_default).toBe(true);
  });

  it('rejects local query strings only with the default localPatterns', () => {
    expect(() => defaultLoader({ config, src: '/a.png?v=1', width: 32 })).toThrow(
      `Image with src "/a.png?v=1" is using a query string which is not configured in images.localPatterns.\nRead more: ${IMAGE_DOCS_URL}`,
    );
    const client = clientConfig(undefined, { consumer: 'client' });
    expect(defaultLoader({ config: client, src: '/a.png?v=1', width: 32 })).toBe(
      '/_void/image?url=%2Fa.png%3Fv%3D1&w=32&q=75',
    );
    const custom = clientConfig({ localPatterns: [{ pathname: '/a.png', search: '?v=1' }] });
    expect(defaultLoader({ config: custom, src: '/a.png?v=1', width: 32 })).toBe(
      '/_void/image?url=%2Fa.png%3Fv%3D1&w=32&q=75',
    );
  });

  it('requires src and width in development', () => {
    const dev = clientConfig(undefined, { dev: true });
    expect(() => defaultLoader({ config: dev, src: '', width: 0 })).toThrow(
      'Void Image Optimization requires src, width to be provided. Make sure you pass them as props to the `Image` component. Received: {"src":"","width":0}',
    );
    // Production does not run the check.
    expect(defaultLoader({ config, src: '/a.png', width: 0 })).toBe(
      '/_void/image?url=%2Fa.png&w=0&q=75',
    );
  });

  it('allows static ?image imports when localPatterns are set', () => {
    const dev = clientConfig({ localPatterns: [{ pathname: '/img/**' }] }, { dev: true });
    expect(defaultLoader({ config: dev, src: '/assets/a.123.png', width: 32 })).toBe(
      '/_void/image?url=%2Fassets%2Fa.123.png&w=32&q=75',
    );
    expect(() => defaultLoader({ config: dev, src: '/other/a.png', width: 32 })).toThrow(
      'does not match `images.localPatterns` configured in your `void.config.ts`',
    );
  });
});

describe('cloudflareLoader', () => {
  const config = clientConfig({ loader: 'cloudflare', qualities: [60, 85] });

  it('builds zone transformation URLs under /cdn-cgi/image', () => {
    expect(config.path).toBe('/cdn-cgi/image');
    expect(cloudflareLoader({ config, src: '/photos/a.jpg', width: 640, quality: 80 })).toBe(
      '/cdn-cgi/image/width=640,quality=85,format=auto/photos/a.jpg',
    );
    expect(cloudflareLoader({ config, src: 'https://example.com/a.jpg', width: 32 })).toBe(
      '/cdn-cgi/image/width=32,quality=85,format=auto/https://example.com/a.jpg',
    );
    expect(cloudflareLoader.__void_img_default).toBe(true);
  });

  it('uses a custom path without doubling its trailing slash', () => {
    for (const path of [
      'https://img.example.com/cdn-cgi/image',
      'https://img.example.com/cdn-cgi/image/',
    ]) {
      const custom = clientConfig({ loader: 'cloudflare', path });
      expect(cloudflareLoader({ config: custom, src: '/a.png', width: 128 })).toBe(
        'https://img.example.com/cdn-cgi/image/width=128,quality=75,format=auto/a.png',
      );
    }
  });

  it('returns src unchanged in development', () => {
    const dev = clientConfig({ loader: 'cloudflare' }, { dev: true });
    expect(cloudflareLoader({ config: dev, src: '/a.png', width: 128 })).toBe('/a.png');
  });

  it('percent-encodes whitespace in src so srcset candidates stay valid', () => {
    expect(cloudflareLoader({ config, src: '/images/a b.png', width: 128 })).toBe(
      '/cdn-cgi/image/width=128,quality=85,format=auto/images/a%20b.png',
    );
    expect(cloudflareLoader({ config, src: '/images/a%20b.png', width: 128 })).toBe(
      '/cdn-cgi/image/width=128,quality=85,format=auto/images/a%20b.png',
    );
    expect(
      cloudflareLoader({ config, src: 'https://example.com/a b\tc.jpg?x=1,2', width: 32 }),
    ).toBe(
      '/cdn-cgi/image/width=32,quality=85,format=auto/https://example.com/a%20b%09c.jpg?x=1,2',
    );
    const dev = clientConfig({ loader: 'cloudflare' }, { dev: true });
    expect(cloudflareLoader({ config: dev, src: '/images/a b.png', width: 128 })).toBe(
      '/images/a%20b.png',
    );

    const { srcSet } = getImgProps(
      { src: '/images/a b.png', alt: '', width: 100, height: 100 },
      { defaultLoader: cloudflareLoader, imgConf: config },
    ).props;
    expect(srcSet).toBe(
      '/cdn-cgi/image/width=128,quality=85,format=auto/images/a%20b.png 1x, /cdn-cgi/image/width=256,quality=85,format=auto/images/a%20b.png 2x',
    );
  });
});

describe('getImageBlurSvg', () => {
  it('sizes the SVG from blur dimensions, then from the image', () => {
    expect(
      getImageBlurSvg({
        blurWidth: 8,
        blurHeight: 6,
        widthInt: 800,
        heightInt: 600,
        blurDataURL: 'x',
      }),
    ).toContain("viewBox='0 0 320 240'");
    const svg = getImageBlurSvg({ widthInt: 100, heightInt: 50, blurDataURL: 'data:x' });
    expect(svg).toContain("viewBox='0 0 100 50'");
    expect(svg).toContain("preserveAspectRatio='none'");
    expect(svg).toContain("href='data:x'");
  });

  it('follows objectFit without dimensions', () => {
    expect(getImageBlurSvg({ blurDataURL: 'x', objectFit: 'contain' })).toContain(
      "preserveAspectRatio='xMidYMid'",
    );
    expect(getImageBlurSvg({ blurDataURL: 'x', objectFit: 'cover' })).toContain(
      "preserveAspectRatio='xMidYMid slice'",
    );
    expect(getImageBlurSvg({ blurDataURL: 'x' })).toContain("preserveAspectRatio='none'");
  });
});

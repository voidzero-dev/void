import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  compileLocalPattern,
  getImageConfigWarnings,
  imageOptimizerConfigured,
  isImageOptimizerActive,
  resolveImageConfig,
  setImageAssetsDir,
  toClientImageConfig,
  toMountedImageConfig,
  validateImagesConfig,
} from '../../src/image-config.ts';
import {
  IMAGE_DOCS_URL,
  hasLocalMatch,
  imageConfigDefault,
  type ImageConfig,
  type ResolvedImageConfig,
} from '../../src/image/index.ts';

const root = join(import.meta.dirname, '.tmp-image-config-test');

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib/loader.ts'), 'export default ({ src }) => src;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const resolve = (
  images: ImageConfig | undefined,
  options: Partial<Parameters<typeof resolveImageConfig>[1]> = {},
) => resolveImageConfig(images, { root, dev: false, ...options });

describe('validateImagesConfig', () => {
  const validate = (value: unknown) => () => validateImagesConfig(value, 'void.config.ts');

  it('accepts undefined, an empty object and every Next.js key', () => {
    expect(validate(undefined)).not.toThrow();
    expect(validate({})).not.toThrow();
    expect(
      validate({
        deviceSizes: [640, 10000],
        imageSizes: [],
        qualities: [1, 100],
        formats: ['image/avif', 'image/webp'],
        minimumCacheTTL: 0,
        remotePatterns: [
          new URL('https://example.com/a/**'),
          { protocol: 'https', hostname: '**.example.com', port: '', pathname: '/**', search: '' },
        ],
        localPatterns: [{ pathname: '/img/**', search: '' }, {}],
        dangerouslyAllowSVG: true,
        dangerouslyAllowLocalIP: false,
        contentSecurityPolicy: "default-src 'none'",
        contentDispositionType: 'inline',
        maximumRedirects: 20,
        maximumResponseBody: 1,
        loader: 'cloudflare',
        loaderFile: './loader.ts',
        path: '/img',
        unoptimized: false,
        domains: ['example.com'],
        maximumDiskCacheSize: 0,
        disableStaticImages: false,
        customCacheHandler: false,
      }),
    ).not.toThrow();
  });

  it.each([
    ['a string', 'x', '"images" in void.config.ts must be an object.'],
    ['an array', [], '"images" in void.config.ts must be an object.'],
    ['a URL', new URL('https://example.com'), '"images" in void.config.ts must be an object.'],
    [
      'an unknown key',
      { sizes: [1] },
      "Unknown key 'images.sizes' in void.config.ts. Valid: deviceSizes, imageSizes, qualities, formats, minimumCacheTTL, remotePatterns, localPatterns, dangerouslyAllowSVG, dangerouslyAllowLocalIP, contentSecurityPolicy, contentDispositionType, maximumRedirects, maximumResponseBody, loader, loaderFile, path, unoptimized, domains, maximumDiskCacheSize, disableStaticImages, customCacheHandler.",
    ],
    [
      'deviceSizes above 10000',
      { deviceSizes: [10001] },
      '"images.deviceSizes" in void.config.ts must be an array of at most 25 integers between 1 and 10000.',
    ],
    ['deviceSizes with 0', { deviceSizes: [0] }, '"images.deviceSizes"'],
    [
      '26 deviceSizes',
      { deviceSizes: Array.from({ length: 26 }, (_, i) => i + 1) },
      '"images.deviceSizes"',
    ],
    ['fractional imageSizes', { imageSizes: [1.5] }, '"images.imageSizes"'],
    [
      'empty qualities',
      { qualities: [] },
      '"images.qualities" in void.config.ts must be an array of 1 to 20 integers between 1 and 100.',
    ],
    ['quality 101', { qualities: [101] }, '"images.qualities"'],
    [
      '21 qualities',
      { qualities: Array.from({ length: 21 }, (_, i) => i + 1) },
      '"images.qualities"',
    ],
    [
      'an unknown format',
      { formats: ['image/png'] },
      '"images.formats" in void.config.ts must be an array of at most 4 of: image/avif, image/webp.',
    ],
    ['five formats', { formats: Array(5).fill('image/webp') }, '"images.formats"'],
    [
      'negative minimumCacheTTL',
      { minimumCacheTTL: -1 },
      '"images.minimumCacheTTL" in void.config.ts must be a non-negative integer.',
    ],
    ['remotePatterns not an array', { remotePatterns: {} }, '"images.remotePatterns"'],
    [
      '51 remotePatterns',
      { remotePatterns: Array(51).fill({ hostname: 'a' }) },
      '"images.remotePatterns"',
    ],
    [
      'a remote pattern without hostname',
      { remotePatterns: [{ pathname: '/**' }] },
      '"images.remotePatterns[0].hostname" in void.config.ts must be a string.',
    ],
    [
      'a remote pattern with an unknown key',
      { remotePatterns: [{ hostname: 'a', host: 'a' }] },
      "Unknown key 'images.remotePatterns[0].host'",
    ],
    [
      'a remote pattern with protocol ftp',
      { remotePatterns: [{ hostname: 'a', protocol: 'ftp' }] },
      '"images.remotePatterns[0].protocol" in void.config.ts must be "http" or "https".',
    ],
    [
      'a remote pattern with a long port',
      { remotePatterns: [{ hostname: 'a', port: '123456' }] },
      '"images.remotePatterns[0].port" in void.config.ts must be a string of at most 5 characters.',
    ],
    [
      'a remote pattern with a numeric port',
      { remotePatterns: [{ hostname: 'a', port: 443 }] },
      '"images.remotePatterns[0].port"',
    ],
    [
      '26 localPatterns',
      { localPatterns: Array(26).fill({}) },
      '"images.localPatterns" in void.config.ts must be an array of at most 25 patterns.',
    ],
    [
      'a local pattern with an unknown key',
      { localPatterns: [{ path: '/x' }] },
      "Unknown key 'images.localPatterns[0].path'",
    ],
    [
      'a local pattern with a numeric search',
      { localPatterns: [{ search: 1 }] },
      '"images.localPatterns[0].search" in void.config.ts must be a string.',
    ],
    [
      'a non-boolean unoptimized',
      { unoptimized: 'yes' },
      '"images.unoptimized" in void.config.ts must be a boolean.',
    ],
    [
      'a non-boolean dangerouslyAllowSVG',
      { dangerouslyAllowSVG: 1 },
      '"images.dangerouslyAllowSVG"',
    ],
    ['a non-string path', { path: 1 }, '"images.path" in void.config.ts must be a string.'],
    ['a non-string loaderFile', { loaderFile: true }, '"images.loaderFile"'],
    [
      'an unknown contentDispositionType',
      { contentDispositionType: 'download' },
      '"images.contentDispositionType" in void.config.ts must be "inline" or "attachment".',
    ],
    [
      '21 maximumRedirects',
      { maximumRedirects: 21 },
      '"images.maximumRedirects" in void.config.ts must be an integer between 0 and 20.',
    ],
    [
      'zero maximumResponseBody',
      { maximumResponseBody: 0 },
      '"images.maximumResponseBody" in void.config.ts must be a positive integer.',
    ],
    [
      'negative maximumDiskCacheSize',
      { maximumDiskCacheSize: -1 },
      '"images.maximumDiskCacheSize"',
    ],
    [
      'an unknown loader',
      { loader: 'fastly' },
      '"images.loader" in void.config.ts must be one of: default, imgix, cloudinary, akamai, custom, cloudflare.',
    ],
    [
      '51 domains',
      { domains: Array(51).fill('a') },
      '"images.domains" in void.config.ts must be an array of at most 50 strings.',
    ],
    ['null deviceSizes', { deviceSizes: null }, '"images.deviceSizes"'],
  ])('rejects %s', (_label, value, message) => {
    expect(validate(value)).toThrow(message);
  });
});

describe('getImageConfigWarnings', () => {
  it('warns about deprecated and ignored keys', () => {
    expect(getImageConfigWarnings(undefined, 'void.config.ts')).toEqual([]);
    expect(
      getImageConfigWarnings(
        { domains: [], disableStaticImages: false, customCacheHandler: false },
        'void.config.ts',
      ),
    ).toEqual([]);
    expect(
      getImageConfigWarnings(
        {
          domains: ['example.com'],
          maximumDiskCacheSize: 0,
          disableStaticImages: true,
          customCacheHandler: true,
        },
        'void.config.ts',
      ),
    ).toEqual([
      '`images.domains` is deprecated in favor of `images.remotePatterns`. Please update void.config.ts to protect your application from malicious users.',
      '"images.maximumDiskCacheSize" in void.config.ts is ignored: optimized images are cached in the Cloudflare cache, not on disk.',
      '"images.disableStaticImages" in void.config.ts is ignored: image imports return URLs unless they end with "?image".',
      '"images.customCacheHandler" in void.config.ts is ignored: optimized images are cached in the Cloudflare cache.',
    ]);
  });
});

describe('resolveImageConfig', () => {
  it('resolves Next.js defaults with the /_void/image path', () => {
    const resolved = resolve(undefined);
    expect(resolved).toEqual({
      deviceSizes: imageConfigDefault.deviceSizes,
      imageSizes: imageConfigDefault.imageSizes,
      allSizes: [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840],
      qualities: [75],
      formats: ['image/webp'],
      minimumCacheTTL: 14400,
      remotePatterns: [],
      localPatterns: [
        {
          pathname: '**',
          search: '',
          pathnameRe: String.raw`^(?:(?!(?:^|\/)\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\/?)$`,
        },
      ],
      domains: [],
      dangerouslyAllowSVG: false,
      dangerouslyAllowLocalIP: false,
      contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
      contentDispositionType: 'attachment',
      maximumRedirects: 3,
      maximumResponseBody: 20_000_000,
      loader: 'default',
      loaderFile: '',
      path: '/_void/image',
      unoptimized: false,
      noOptimizer: false,
      dev: false,
    });
    expect(isImageOptimizerActive(resolved)).toBe(true);
    // JSON-serializable, so it can be baked into generated code.
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
  });

  it('sorts sizes and qualities, drops undefined and null, and caps the body size', () => {
    const resolved = resolve({
      deviceSizes: [1200, 400],
      imageSizes: [64, 16],
      qualities: [90, 40],
      formats: ['image/avif', 'image/webp'],
      maximumResponseBody: 1000,
      minimumCacheTTL: undefined,
      path: null as unknown as string,
    });
    expect(resolved).toMatchObject({
      deviceSizes: [400, 1200],
      imageSizes: [16, 64],
      allSizes: [16, 64, 400, 1200],
      qualities: [40, 90],
      formats: ['image/avif', 'image/webp'],
      maximumResponseBody: 1000,
      minimumCacheTTL: 14400,
      path: '/_void/image',
    });
  });

  it('appends the static import pattern to user localPatterns once', () => {
    expect(resolve({ localPatterns: [{ pathname: '/img/**' }] }).localPatterns).toEqual([
      expect.objectContaining({ pathname: '/img/**' }),
      expect.objectContaining({ pathname: '/assets/**', search: '' }),
    ]);
    expect(
      resolve({ localPatterns: [{ pathname: '/assets/**', search: '' }] }).localPatterns,
    ).toHaveLength(1);
  });

  it('allows static imports under a custom build.assetsDir', () => {
    const allows = (resolved: ResolvedImageConfig, path: string) =>
      hasLocalMatch(resolved.localPatterns, path);
    const images: ImageConfig = { localPatterns: [{ pathname: '/photos/**', search: '' }] };
    const resolved = resolve(images, { assetsDir: '/static/' });
    expect(resolved.localPatterns.map((p) => p.pathname)).toEqual(['/photos/**', '/static/**']);
    expect(allows(resolved, '/static/hero-abc.png')).toBe(true);
    expect(allows(resolved, '/assets/hero-abc.png')).toBe(false);

    // The plugin learns `build.assetsDir` after resolving; later entries are kept.
    const late = resolve(images);
    late.localPatterns.push(compileLocalPattern({ pathname: '/@fs/**', search: '' }));
    setImageAssetsDir(late, 'static');
    expect(late.localPatterns.map((p) => p.pathname)).toEqual([
      '/photos/**',
      '/static/**',
      '/@fs/**',
    ]);
    expect(allows(late, '/static/hero-abc.png')).toBe(true);
    expect(allows(late, '/assets/hero-abc.png')).toBe(false);
    setImageAssetsDir(late, 'assets');
    expect(late.localPatterns.map((p) => p.pathname)).toEqual([
      '/photos/**',
      '/assets/**',
      '/@fs/**',
    ]);

    // A pattern the user lists is not added twice; an empty assetsDir is the root.
    const listed = resolve({ localPatterns: [{ pathname: '/assets/**', search: '' }] });
    setImageAssetsDir(listed, 'static');
    expect(listed.localPatterns.map((p) => p.pathname)).toEqual(['/assets/**', '/static/**']);
    setImageAssetsDir(listed, '');
    expect(listed.localPatterns.map((p) => p.pathname)).toEqual(['/assets/**', '/*']);
    expect(allows(listed, '/hero-abc.png')).toBe(true);

    // Without user localPatterns every path is already allowed.
    const open = resolve(undefined);
    setImageAssetsDir(open, 'static');
    expect(open.localPatterns.map((p) => p.pathname)).toEqual(['**']);
  });

  it('normalizes remote patterns', () => {
    const [fromUrl, plain] = resolve({
      remotePatterns: [new URL('https://example.com/a/**'), { hostname: '*.example.com' }],
    }).remotePatterns;
    expect(fromUrl).toEqual({
      protocol: 'https',
      hostname: 'example.com',
      port: '',
      pathname: '/a/**',
      search: '',
      hostnameRe: expect.any(String),
      pathnameRe: expect.any(String),
    });
    expect(Object.keys(plain)).toEqual(['hostname', 'hostnameRe', 'pathnameRe']);
  });

  it('requires a path for loaders other than default, custom and cloudflare', () => {
    expect(() => resolve({ loader: 'imgix' })).toThrow(
      `Specified images.loader property (imgix) also requires images.path property to be assigned to a URL prefix.\nSee more info here: ${IMAGE_DOCS_URL}`,
    );
    expect(resolve({ loader: 'imgix', path: 'https://x.imgix.net' }).path).toBe(
      'https://x.imgix.net/',
    );
    expect(resolve({ loader: 'custom' }).path).toBe('/_void/image/');
  });

  it('defaults the Cloudflare loader path to /cdn-cgi/image without a trailing slash', () => {
    const resolved = resolve({ loader: 'cloudflare' });
    expect(resolved.path).toBe('/cdn-cgi/image');
    expect(isImageOptimizerActive(resolved)).toBe(false);
    expect(resolve({ loader: 'cloudflare', path: 'https://example.com/cdn-cgi/image' }).path).toBe(
      'https://example.com/cdn-cgi/image',
    );
  });

  it('resolves loaderFile from the project root', () => {
    const resolved = resolve({ loaderFile: './lib/loader.ts' });
    expect(resolved.loaderFile).toBe(join(root, 'lib/loader.ts').replaceAll('\\', '/'));
    expect(resolved.loader).toBe('default');
    expect(isImageOptimizerActive(resolved)).toBe(false);
    expect(resolve({ loader: 'custom', loaderFile: 'lib/loader.ts' }).path).toBe('/_void/image/');
  });

  it('resolves a loaderFile with a leading slash from the project root, as Next.js joins it', () => {
    const inRoot = join(root, 'lib/loader.ts').replaceAll('\\', '/');
    expect(resolve({ loader: 'custom', loaderFile: '/lib/loader.ts' }).loaderFile).toBe(inRoot);
    // An absolute path to an existing file still works.
    expect(resolve({ loader: 'custom', loaderFile: inRoot }).loaderFile).toBe(inRoot);
    expect(() => resolve({ loaderFile: '/missing.ts' })).toThrow(
      `Specified images.loaderFile does not exist at "${join(root, 'missing.ts').replaceAll('\\', '/')}".`,
    );
  });

  it('rejects a missing loaderFile and loaderFile with a built-in CDN loader', () => {
    expect(() => resolve({ loaderFile: './missing.ts' })).toThrow(
      `Specified images.loaderFile does not exist at "${join(root, 'missing.ts')}".`,
    );
    expect(() => resolve({ loader: 'cloudflare', loaderFile: './lib/loader.ts' })).toThrow(
      'Specified images.loader property (cloudflare) cannot be used with images.loaderFile property. Please set images.loader to "custom".',
    );
  });

  it.each([
    ['node target', { target: 'node' }],
    ['bun target', { target: 'bun' }],
    ['deno target', { target: 'deno' }],
    ['static output', { output: 'static' as const }],
    ['Void Platform build', { managed: true }],
  ])('has no optimizer for a %s unless a custom loader is set', (_label, options) => {
    const resolved = resolve(undefined, options);
    // `unoptimized` stays the user's switch, so `loader` props still apply.
    expect(resolved.unoptimized).toBe(false);
    expect(resolved.noOptimizer).toBe(true);
    expect(toClientImageConfig(resolved, 'client').noOptimizer).toBe(true);
    expect(isImageOptimizerActive(resolved)).toBe(false);
    expect(resolve({ unoptimized: true }, options).unoptimized).toBe(true);
    expect(resolve({ loader: 'cloudflare' }, options).noOptimizer).toBe(false);
    expect(resolve({ loader: 'custom' }, options).noOptimizer).toBe(false);
    expect(resolve({ loaderFile: './lib/loader.ts' }, options).noOptimizer).toBe(false);
    expect(imageOptimizerConfigured(undefined, options)).toBe(false);
  });

  it('keeps the optimizer for Cloudflare server builds', () => {
    const resolved = resolve(undefined, { target: 'cloudflare', output: 'server', dev: true });
    expect(resolved.unoptimized).toBe(false);
    expect(resolved.noOptimizer).toBe(false);
    expect(resolved.dev).toBe(true);
  });
});

describe('isImageOptimizerActive and imageOptimizerConfigured', () => {
  it.each([
    [undefined, true],
    [{}, true],
    [{ path: '/img' }, true],
    [{ unoptimized: true }, false],
    [{ loader: 'custom' as const }, false],
    [{ loader: 'cloudflare' as const }, false],
    [{ loaderFile: './lib/loader.ts' }, false],
    // A CDN in front of the app: the endpoint is served at the URL's path.
    [{ path: 'https://images.example.com/_next/image' }, true],
    [{ path: '//images.example.com/_void/image' }, true],
    [{ path: 'https://images.example.com' }, false],
    [{ path: 'https://images.example.com/' }, false],
    [{ path: 'images/optimize' }, false],
  ])('%j is %s', (images, expected) => {
    expect(imageOptimizerConfigured(images, {})).toBe(expected);
    expect(imageOptimizerConfigured(images, { target: 'cloudflare', output: 'server' })).toBe(
      expected,
    );
    expect(isImageOptimizerActive(resolve(images))).toBe(expected);
  });

  it('mounts an absolute images.path at its pathname and keeps the URL for Image', () => {
    const resolved = resolve({ path: 'https://images.example.com/_next/image' });
    const mounted = toMountedImageConfig(resolved);
    expect(mounted.path).toBe('/_next/image');
    expect(isImageOptimizerActive(mounted)).toBe(true);
    expect(resolved.path).toBe('https://images.example.com/_next/image');
    expect(toClientImageConfig(resolved, 'client').path).toBe(
      'https://images.example.com/_next/image',
    );
    expect(toMountedImageConfig(resolve({ path: '//cdn.example.com/img' })).path).toBe('/img');

    const relative = resolve({ path: '/img' });
    expect(toMountedImageConfig(relative)).toBe(relative);
  });
});

describe('toClientImageConfig', () => {
  it('sends patterns to server environments and to the client only in development', () => {
    const images: ImageConfig = {
      remotePatterns: [{ hostname: 'example.com' }],
      domains: ['example.org'],
    };
    const keys = [
      'deviceSizes',
      'imageSizes',
      'allSizes',
      'qualities',
      'path',
      'loader',
      'dangerouslyAllowSVG',
      'unoptimized',
      'dev',
    ];
    expect(Object.keys(toClientImageConfig(resolve(images), 'client'))).toEqual(keys);
    const server = toClientImageConfig(resolve(images), 'server');
    expect(Object.keys(server)).toEqual([...keys, 'localPatterns', 'remotePatterns', 'domains']);
    expect(server.domains).toEqual(['example.org']);
    expect(Object.keys(toClientImageConfig(resolve(images, { dev: true }), 'client'))).toEqual([
      ...keys,
      'localPatterns',
      'remotePatterns',
      'domains',
    ]);
  });
});

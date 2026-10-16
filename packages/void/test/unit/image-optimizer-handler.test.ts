import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveImageConfig } from '../../src/image-config.ts';
import type { ImageConfig, ResolvedImageConfig } from '../../src/image/config.ts';
import {
  getImageEtag,
  handleImageRequest,
  type ImageCacheLike,
  type ImageRequestOptions,
  type ImagesBindingLike,
} from '../../src/image/optimizer/index.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { createImageHandler } from '../../src/runtime/routing.ts';

const fixture = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(join(import.meta.dirname, '../fixtures/images', name)));
const OUTPUTS: Record<string, Uint8Array<ArrayBuffer>> = {
  'image/webp': fixture('test.webp'),
  'image/avif': fixture('test.avif'),
  'image/jpeg': fixture('test.jpg'),
  'image/png': fixture('test.png'),
};
const CHROME = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
const SAFARI = 'image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5';
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
);
const HTML = new TextEncoder().encode('<!doctype html><html><body>app</body></html>');

const config = (images?: ImageConfig, dev = false): ResolvedImageConfig =>
  resolveImageConfig(images, { root: '/', dev });

type BindingCall = {
  source?: Uint8Array;
  transforms: Array<unknown>;
  output?: { format: string; quality: number };
};

function fakeBinding(failure?: unknown): { binding: ImagesBindingLike; calls: Array<BindingCall> } {
  const calls: Array<BindingCall> = [];
  const binding: ImagesBindingLike = {
    input(stream) {
      const call: BindingCall = { transforms: [] };
      calls.push(call);
      const transformer = {
        transform(transform: { width: number; fit: 'scale-down' }) {
          call.transforms.push(transform);
          return transformer;
        },
        async output(options: { format: 'image/webp'; quality: number }) {
          call.output = options;
          call.source = new Uint8Array(await new Response(stream).arrayBuffer());
          if (failure !== undefined) {
            throw failure;
          }
          return { image: () => new Response(OUTPUTS[options.format]).body! };
        },
      };
      return transformer;
    },
  };
  return { binding, calls };
}

function fakeAssets(
  files: Record<string, { body: Uint8Array; headers?: Record<string, string> }>,
): {
  assets: { fetch(request: Request): Promise<Response> };
  requests: Array<Request>;
} {
  const requests: Array<Request> = [];
  return {
    requests,
    assets: {
      async fetch(request) {
        requests.push(request);
        const file = files[new URL(request.url).pathname];
        return file
          ? new Response(file.body.slice(), { headers: file.headers })
          : new Response('not found', { status: 404 });
      },
    },
  };
}

function fakeCache(): {
  cache: ImageCacheLike;
  entries: Map<string, Response>;
  failing: { match: boolean; put: boolean };
} {
  const entries = new Map<string, Response>();
  const failing = { match: false, put: false };
  return {
    entries,
    failing,
    cache: {
      async match(request) {
        if (failing.match) {
          throw new Error('cache unavailable');
        }
        return entries.get(request.url)?.clone();
      },
      async put(request, response) {
        if (failing.put) {
          throw new Error('cache unavailable');
        }
        entries.set(request.url, new Response(await response.arrayBuffer(), response));
      },
    },
  };
}

function background(): {
  waitUntil: (promise: Promise<unknown>) => void;
  settled: () => Promise<void>;
} {
  const pending: Array<Promise<unknown>> = [];
  return {
    waitUntil: (promise) => pending.push(promise),
    settled: async () => {
      await Promise.all(pending);
    },
  };
}

const request = (query: string, headers: Record<string, string> = {}, method = 'GET'): Request =>
  new Request(`https://app.test/_void/image?${query}`, { headers, method });

const png = { '/test.png': { body: fixture('test.png') } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('handleImageRequest', () => {
  const run = (req: Request, overrides: Partial<ImageRequestOptions> = {}): Promise<Response> =>
    handleImageRequest(req, {
      config: config(),
      deploymentId: 'deployment-1',
      assets: fakeAssets(png).assets,
      binding: fakeBinding().binding,
      ...overrides,
    });

  it('accepts only GET and HEAD', async () => {
    const response = await run(request('url=/test.png&w=64&q=75', {}, 'POST'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it.each<[string, ImageConfig]>([
    ['unoptimized', { unoptimized: true }],
    ['a custom loader', { loader: 'custom' }],
  ])('answers 404 when %s images bypass the endpoint', async (_name, images) => {
    const response = await run(request('url=/test.png&w=64&q=75'), { config: config(images) });
    expect(response.status).toBe(404);
  });

  it('answers validation errors with Next.js plain-text messages', async () => {
    const response = await run(request('url=/test.png&w=1000&q=75'));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('"w" parameter (width) of 1000 is not allowed');
  });

  it('resizes a local source with the Images binding and sends Next.js headers', async () => {
    const { binding, calls } = fakeBinding();
    const { assets, requests } = fakeAssets({
      ...png,
    });
    const response = await run(
      request('url=/test.png&w=64&q=75', { accept: 'image/webp,*/*', cookie: 'session=secret' }),
      { binding, assets },
    );
    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(OUTPUTS['image/webp']);
    expect(Object.fromEntries(response.headers)).toEqual({
      vary: 'Accept',
      'cache-control': 'public, max-age=14400, must-revalidate',
      etag: `"${await getImageEtag(OUTPUTS['image/webp'])}"`,
      'content-type': 'image/webp',
      'content-disposition': 'attachment; filename="test.webp"',
      'content-security-policy': `script-src 'none'; frame-src 'none'; sandbox;`,
      'x-content-type-options': 'nosniff',
      'x-void-image-cache': 'MISS',
      'content-length': String(body.byteLength),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      source: fixture('test.png'),
      transforms: [{ width: 64, fit: 'scale-down' }],
      output: { format: 'image/webp', quality: 75 },
    });
    // The source request carries none of the client's headers.
    expect(requests).toHaveLength(1);
    expect([...requests[0].headers]).toEqual([]);
  });

  it.each<[string, string, string, string | null]>([
    ['PNG', 'test.png', 'image/png', 'image/png'],
    ['JPEG', 'test.jpg', 'image/jpeg', 'image/jpeg'],
    ['WebP', 'test.webp', 'image/jpeg', 'image/jpeg'],
    ['AVIF', 'test.avif', 'image/jpeg', 'image/jpeg'],
    ['a static GIF', 'test.gif', 'image/gif', null],
    ['TIFF', 'test.tiff', 'image/tiff', null],
  ])(
    'keeps %s in a format the client accepts without negotiation',
    async (_name, file, type, binaryOutput) => {
      const { binding, calls } = fakeBinding();
      const response = await run(request(`url=/${file}&w=64&q=75`, { accept: SAFARI }), {
        binding,
        assets: fakeAssets({ [`/${file}`]: { body: fixture(file) } }).assets,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(calls.map((call) => call.output?.format ?? null)).toEqual(
        binaryOutput ? [binaryOutput] : [],
      );
      if (!binaryOutput) {
        // The binding cannot encode this type, so the original is served.
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture(file));
      }
    },
  );

  it.each([
    ['test.gif', 'image/webp'],
    ['test.tiff', 'image/webp'],
    ['test.jpg', 'image/webp'],
  ])('converts %s to a negotiated %s', async (file, type) => {
    const { binding, calls } = fakeBinding();
    const response = await run(request(`url=/${file}&w=64&q=75`, { accept: 'image/webp' }), {
      binding,
      assets: fakeAssets({ [`/${file}`]: { body: fixture(file) } }).assets,
    });
    expect(response.headers.get('content-type')).toBe(type);
    expect(calls).toHaveLength(1);
  });

  it('negotiates formats in configured order and skips AVIF above 1200 pixels', async () => {
    const images: ImageConfig = { formats: ['image/avif', 'image/webp'] };
    const formatFor = async (width: number): Promise<string | null> => {
      const response = await run(request(`url=/test.png&w=${width}&q=75`, { accept: CHROME }), {
        config: config(images),
      });
      return response.headers.get('content-type');
    };
    expect(await formatFor(1200)).toBe('image/avif');
    expect(await formatFor(1920)).toBe('image/webp');
  });

  it.each(['animated.gif', 'animated.png', 'animated.webp'])(
    'serves the animated %s unchanged and warns once',
    async (file) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { binding, calls } = fakeBinding();
      const options = {
        binding,
        assets: fakeAssets({ [`/${file}`]: { body: fixture(file) } }).assets,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await run(
          request(`url=/${file}&w=64&q=75`, { accept: 'image/webp' }),
          options,
        );
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture(file));
        expect(response.headers.get('cache-control')).toBe(
          'public, max-age=14400, must-revalidate',
        );
      }
      expect(calls).toEqual([]);
      expect(warn.mock.calls).toEqual([
        [
          `[void] The requested resource "/${file}" is an animated image so it will not be optimized. Consider adding the "unoptimized" property to the <Image>.`,
        ],
      ]);
    },
  );

  it('serves SVG unchanged only with dangerouslyAllowSVG', async () => {
    const assets = fakeAssets({ '/icon.svg': { body: SVG } }).assets;
    const rejected = await run(request('url=/icon.svg&w=64&q=75'), { assets });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe('"url" parameter is valid but image type is not allowed');
    const allowed = await run(request('url=/icon.svg&w=64&q=75', { accept: 'image/webp' }), {
      assets,
      config: config({ dangerouslyAllowSVG: true }),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toBe('image/svg+xml');
    expect(allowed.headers.get('content-security-policy')).toBe(
      `script-src 'none'; frame-src 'none'; sandbox;`,
    );
    expect(allowed.headers.get('content-disposition')).toBe('attachment; filename="icon.svg"');
    expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(SVG);
  });

  it.each([
    ['ICO', new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]), 'image/x-icon'],
    ['BMP', new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]), 'image/bmp'],
  ])('passes %s through without a transform', async (_name, body, type) => {
    const { binding, calls } = fakeBinding();
    const response = await run(request('url=/file&w=64&q=75', { accept: 'image/webp' }), {
      binding,
      assets: fakeAssets({ '/file': { body } }).assets,
    });
    expect(response.headers.get('content-type')).toBe(type);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(calls).toEqual([]);
  });

  it('rejects responses that are not images, such as an SPA fallback page', async () => {
    const response = await run(request('url=/missing.png&w=64&q=75'), {
      assets: fakeAssets({
        '/missing.png': { body: HTML, headers: { 'content-type': 'text/html' } },
      }).assets,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("The requested resource isn't a valid image.");
  });

  it('passes the source status through for a missing local file', async () => {
    const response = await run(request('url=/nope.png&w=64&q=75'));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('"url" parameter is valid but internal response is invalid');
  });

  it('uses the longer of minimumCacheTTL and the source max-age, and max-age=0 in development', async () => {
    const assets = fakeAssets({
      '/test.png': {
        body: fixture('test.png'),
        headers: { 'cache-control': 'public, max-age=31536000' },
      },
    }).assets;
    const production = await run(request('url=/test.png&w=64&q=75'), { assets });
    expect(production.headers.get('cache-control')).toBe(
      'public, max-age=31536000, must-revalidate',
    );
    const development = await run(request('url=/test.png&w=64&q=75'), {
      assets,
      config: config(undefined, true),
    });
    expect(development.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
  });

  it('honors contentDispositionType and contentSecurityPolicy', async () => {
    const response = await run(request('url=/test.png&w=64&q=75', { accept: 'image/webp' }), {
      config: config({
        contentDispositionType: 'inline',
        contentSecurityPolicy: "default-src 'none'",
      }),
    });
    expect(response.headers.get('content-disposition')).toBe('inline; filename="test.webp"');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  it('serves originals with minimumCacheTTL and warns once when the binding is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const assets = fakeAssets({
      '/test.png': {
        body: fixture('test.png'),
        headers: { 'cache-control': 'max-age=99999', etag: '"v1"' },
      },
    }).assets;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await run(request('url=/test.png&w=64&q=75', { accept: 'image/webp' }), {
        assets,
        binding: undefined,
        bindingName: 'MEDIA',
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('public, max-age=14400, must-revalidate');
      expect(response.headers.get('etag')).toBe(`"${Buffer.from('"v1"').toString('base64url')}"`);
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="test.png"');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture('test.png'));
    }
    expect(warn.mock.calls).toEqual([
      [
        '[void] Image optimization is unavailable because the Worker has no Images binding (env.MEDIA), so /_void/image serves original images.',
      ],
    ]);
  });

  it('serves the original when the binding fails and warns once per error code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failures: Array<unknown> = [
      Object.assign(new Error('IMAGES_TRANSFORM_ERROR 9422: monthly limit'), { code: 9422 }),
      { code: 9422, message: 'IMAGES_TRANSFORM_ERROR 9422: monthly limit' },
      { code: 9520, message: 'IMAGES_TRANSFORM_ERROR 9520: unsupported' },
      new TypeError('stream consumed'),
    ];
    for (const failure of failures) {
      const { binding, calls } = fakeBinding(failure);
      const response = await run(request('url=/test.png&w=64&q=75', { accept: 'image/webp' }), {
        binding,
        config: config({ minimumCacheTTL: 60 }),
      });
      expect(calls).toHaveLength(1);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
      expect(response.headers.get('etag')).toBe(`"${await getImageEtag(fixture('test.png'))}"`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture('test.png'));
    }
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[void] The Cloudflare Images Free allowance is used up, so /_void/image serves the original image for new sizes until next month (error 9422).',
      '[void] Cloudflare Images could not transform an image (error 9520: IMAGES_TRANSFORM_ERROR 9520: unsupported), so /_void/image serves the original image.',
      '[void] Image transformation failed (stream consumed), so /_void/image serves the original image.',
    ]);
  });

  it('caches responses by validated parameters and negotiated format', async () => {
    const { cache, entries } = fakeCache();
    const { binding, calls } = fakeBinding();
    const { assets, requests } = fakeAssets(png);
    const tasks = background();
    const options = { binding, assets, cache, waitUntil: tasks.waitUntil };
    const first = await run(
      request('url=/test.png&w=64&q=75&extra=1', { accept: 'image/webp' }),
      options,
    );
    await tasks.settled();
    expect(first.headers.get('x-void-image-cache')).toBe('MISS');
    expect([...entries.keys()]).toEqual([
      'https://app.test/_void/image?url=%2Ftest.png&w=64&q=75&__void_img_fmt=image%2Fwebp&__void_img_v=2&__void_img_dpl=deployment-1',
    ]);
    const second = await run(request('url=/test.png&w=64&q=75', { accept: 'image/webp' }), options);
    expect(second.headers.get('x-void-image-cache')).toBe('HIT');
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(second.headers.get('content-type')).toBe('image/webp');
    expect(second.headers.get('cache-control')).toBe('public, max-age=14400, must-revalidate');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(OUTPUTS['image/webp']);
    expect(calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
    // The Cache API ignores Vary, so another negotiated format is another entry.
    const other = await run(request('url=/test.png&w=64&q=75', { accept: SAFARI }), options);
    await tasks.settled();
    expect(other.headers.get('x-void-image-cache')).toBe('MISS');
    expect(other.headers.get('content-type')).toBe('image/png');
    expect(
      [...entries.keys()].map((key) => new URL(key).searchParams.get('__void_img_fmt')),
    ).toEqual(['image/webp', 'auto']);
  });

  it('scopes cached local sources to the deployment but not remote sources', async () => {
    const { cache, entries } = fakeCache();
    const tasks = background();
    const remote = vi.fn(async () => new Response(fixture('test.png')));
    const options = {
      cache,
      waitUntil: tasks.waitUntil,
      fetch: remote,
      config: config({ remotePatterns: [{ hostname: 'images.test' }] }),
    };
    const local = 'url=/test.png&w=64&q=75';
    const external = `url=${encodeURIComponent('https://images.test/a.png')}&w=64&q=75`;
    for (const query of [local, external]) {
      await run(request(query), { ...options, deploymentId: 'one' });
    }
    await tasks.settled();
    expect(entries.size).toBe(2);
    const next = await run(request(local), { ...options, deploymentId: 'two' });
    expect(next.headers.get('x-void-image-cache')).toBe('MISS');
    const reused = await run(request(external), { ...options, deploymentId: 'two' });
    expect(reused.headers.get('x-void-image-cache')).toBe('HIT');
    expect(remote).toHaveBeenCalledTimes(1);
    expect(
      [...entries.keys()].filter((key) => !new URL(key).searchParams.has('__void_img_dpl')),
    ).toEqual([
      'https://app.test/_void/image?url=https%3A%2F%2Fimages.test%2Fa.png&w=64&q=75&__void_img_fmt=auto&__void_img_v=2',
    ]);
  });

  it('fails open when the cache throws and skips it in development or without waitUntil', async () => {
    const { cache, entries, failing } = fakeCache();
    failing.match = true;
    failing.put = true;
    const tasks = background();
    const broken = await run(request('url=/test.png&w=64&q=75'), {
      cache,
      waitUntil: tasks.waitUntil,
    });
    await tasks.settled();
    expect(broken.status).toBe(200);
    failing.match = false;
    failing.put = false;
    await run(request('url=/test.png&w=64&q=75'), { cache });
    await run(request('url=/test.png&w=64&q=75'), {
      cache,
      waitUntil: tasks.waitUntil,
      config: config(undefined, true),
    });
    await tasks.settled();
    expect(entries.size).toBe(0);
  });

  it('answers a matching If-None-Match with 304 and only the caching headers', async () => {
    const options = { config: config({ qualities: [50, 75] }) };
    const first = await run(request('url=/test.png&w=64&q=75', { accept: 'image/webp' }), options);
    const etag = first.headers.get('etag')!;
    for (const tag of [etag, etag.slice(1, -1), `W/${etag}`]) {
      const response = await run(
        request('url=/test.png&w=64&q=75', { accept: 'image/webp', 'if-none-match': tag }),
        options,
      );
      expect(response.status).toBe(304);
      expect(Object.fromEntries(response.headers)).toEqual({
        vary: 'Accept',
        'cache-control': 'public, max-age=14400, must-revalidate',
        etag,
      });
      expect(await response.text()).toBe('');
    }
    const binding = {
      input: () => ({
        transform() {
          return this;
        },
        output: async () => ({ image: () => new Response(new Uint8Array([1, 2, 3])).body! }),
      }),
    } as unknown as ImagesBindingLike;
    const otherQuality = await run(
      request('url=/test.png&w=64&q=50', { accept: 'image/webp', 'if-none-match': etag }),
      { ...options, binding },
    );
    expect(otherQuality.status).toBe(200);
    expect(otherQuality.headers.get('etag')).not.toBe(etag);
  });

  it('answers HEAD with headers only', async () => {
    const response = await run(
      request('url=/test.png&w=64&q=75', { accept: 'image/webp' }, 'HEAD'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('content-length')).toBe(String(OUTPUTS['image/webp'].byteLength));
    expect(response.body).toBeNull();
  });

  it('marks fingerprinted build assets immutable, including cache hits', async () => {
    const { cache, entries } = fakeCache();
    const tasks = background();
    const isImmutable = vi.fn((pathname: string) => pathname === '/assets/hero-abc123.png');
    const options = {
      cache,
      waitUntil: tasks.waitUntil,
      isImmutable,
      assets: fakeAssets({
        '/assets/hero-abc123.png': {
          body: fixture('test.png'),
          headers: { 'cache-control': 'max-age=0' },
        },
      }).assets,
    };
    const query = 'url=/assets/hero-abc123.png&w=64&q=75';
    const first = await run(request(query), options);
    await tasks.settled();
    const second = await run(request(query), options);
    for (const response of [first, second]) {
      expect(response.headers.get('cache-control')).toBe('public, max-age=315360000, immutable');
    }
    expect(second.headers.get('x-void-image-cache')).toBe('HIT');
    expect([...entries.values()][0].headers.get('cache-control')).toBe('public, max-age=31536000');
    expect(isImmutable).toHaveBeenCalledWith('/assets/hero-abc123.png');
  });

  it('keeps minimumCacheTTL for a fingerprinted original served after a failed transform', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cache, entries } = fakeCache();
    const tasks = background();
    const options = {
      cache,
      waitUntil: tasks.waitUntil,
      isImmutable: () => true,
      binding: fakeBinding({ code: 9422 }).binding,
      assets: fakeAssets({ '/assets/hero-abc123.png': { body: fixture('test.png') } }).assets,
    };
    const query = 'url=/assets/hero-abc123.png&w=64&q=75';
    const first = await run(request(query, { accept: 'image/webp' }), options);
    await tasks.settled();
    // A later request, once the transform works again, still finds the entry
    // until minimumCacheTTL passes.
    const second = await run(request(query, { accept: 'image/webp' }), {
      ...options,
      binding: fakeBinding().binding,
    });
    expect(second.headers.get('x-void-image-cache')).toBe('HIT');
    for (const response of [first, second]) {
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('public, max-age=14400, must-revalidate');
    }
    expect([...entries.values()][0].headers.get('cache-control')).toBe('public, max-age=14400');
  });

  it('refuses a remote redirect to a host outside remotePatterns and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remote = vi.fn(async (input: string) => {
      if (input.startsWith('https://images.partner.com/r')) {
        return new Response(null, {
          status: 302,
          headers: { location: new URL(input).searchParams.get('to')! },
        });
      }
      return new Response(fixture('test.jpg'));
    });
    const options = {
      fetch: remote,
      config: config({
        remotePatterns: [{ hostname: 'images.partner.com' }, { hostname: 'cdn.partner.com' }],
      }),
    };
    const via = (target: string): Request =>
      request(
        `url=${encodeURIComponent(`https://images.partner.com/r?to=${encodeURIComponent(target)}`)}&w=64&q=75`,
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await run(via('http://127.0.0.1.nip.io:5432/'), options);
      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe('"url" parameter is not allowed');
    }
    expect(remote).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls).toEqual([
      [
        "[void] An image source redirected to http://127.0.0.1.nip.io:5432, which images.remotePatterns doesn't allow, so /_void/image refused it. Add the redirect target to images.remotePatterns to optimize it.",
      ],
    ]);
    const followed = await run(via('https://cdn.partner.com/a.jpg'), options);
    expect(followed.status).toBe(200);
    expect(remote).toHaveBeenLastCalledWith('https://cdn.partner.com/a.jpg', expect.anything());
  });

  it('fetches allowed remote sources with the upstream max-age', async () => {
    const remote = vi.fn(
      async (_input: string, _init: RequestInit) =>
        new Response(fixture('test.jpg'), { headers: { 'cache-control': 's-maxage=86400' } }),
    );
    const response = await run(
      request(`url=${encodeURIComponent('https://images.test/photos/a.jpg?size=large')}&w=64&q=75`),
      {
        fetch: remote,
        config: config({ remotePatterns: [{ protocol: 'https', hostname: 'images.test' }] }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400, must-revalidate');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="a.jpeg"');
    expect(remote).toHaveBeenCalledWith(
      'https://images.test/photos/a.jpg?size=large',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });
});

describe('createImageHandler', () => {
  function app(options: Parameters<typeof createImageHandler>[0]): Hono {
    const hono = new Hono();
    hono.get('/_void/image', createImageHandler(options));
    return hono;
  }

  describe('with the app', () => {
    // Mirrors the generated route table: middleware, then the endpoint
    // (given the app), then routes; static files come from ASSETS.
    function guarded(): { hono: Hono; env: Record<string, unknown> } {
      const hono = new Hono();
      hono.use(async (c, next) => {
        if (c.req.path.startsWith('/members/') && c.req.header('cookie') !== 'session=ok') {
          return c.text('Unauthorized', 401);
        }
        if (c.req.path === '/loop.png') {
          return hono.fetch(
            new Request(new URL('/_void/image?url=%2Floop.png&w=64&q=75', c.req.url)),
            c.env,
          );
        }
        await next();
      });
      hono.get(
        '/_void/image',
        createImageHandler(
          { config: config(), deploymentId: 'd1', loadManifest: async () => null },
          hono,
        ),
      );
      hono.get('/route.png', () => new Response(fixture('test.jpg')));
      const files = {
        '/members/premium.png': { body: fixture('test.png') },
        '/test.png': { body: fixture('test.png') },
        '/loop.png': { body: fixture('test.png') },
      };
      return { hono, env: { ASSETS: fakeAssets(files).assets, IMAGES: fakeBinding().binding } };
    }

    it('applies middleware that guards the source path, without the client cookies', async () => {
      const { hono, env } = guarded();
      const direct = await hono.fetch(new Request('https://app.test/members/premium.png'), env);
      expect(direct.status).toBe(401);
      for (const cookie of [undefined, 'session=ok']) {
        const response = await hono.fetch(
          request('url=%2Fmembers%2Fpremium.png&w=3840&q=75', {
            accept: 'image/webp',
            ...(cookie ? { cookie } : {}),
          }),
          env,
        );
        expect(response.status).toBe(401);
        expect(await response.text()).toBe(
          '"url" parameter is valid but internal response is invalid',
        );
      }
    });

    it('falls back to ASSETS when the app answers 404, and uses what routes serve', async () => {
      const { hono, env } = guarded();
      const asset = await hono.fetch(
        request('url=/test.png&w=64&q=75', { accept: 'image/webp' }),
        env,
      );
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toBe('image/webp');
      const route = await hono.fetch(request('url=/route.png&w=64&q=75', { accept: SAFARI }), env);
      expect(route.status).toBe(200);
      expect(route.headers.get('content-type')).toBe('image/jpeg');
    });

    it('answers a source request rewritten back to the endpoint without recursing', async () => {
      const { hono, env } = guarded();
      const response = await hono.fetch(request('url=/loop.png&w=64&q=75'), env);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '"url" parameter is valid but internal response is invalid',
      );
    });
  });

  it('uses ASSETS and IMAGES from the Worker env and caches through caches.default', async () => {
    const { cache, entries } = fakeCache();
    vi.stubGlobal('caches', { default: cache });
    const { binding, calls } = fakeBinding();
    const tasks = background();
    const ctx = { waitUntil: tasks.waitUntil, passThroughOnException() {}, props: {} };
    const env = { ASSETS: fakeAssets(png).assets, IMAGES: binding };
    const hono = app({ config: config(), deploymentId: 'd1', loadManifest: async () => null });
    const first = await hono.fetch(
      request('url=/test.png&w=64&q=75', { accept: 'image/webp' }),
      env,
      ctx,
    );
    await tasks.settled();
    const second = await hono.fetch(
      request('url=/test.png&w=64&q=75', { accept: 'image/webp' }),
      env,
      ctx,
    );
    expect(first.headers.get('x-void-image-cache')).toBe('MISS');
    expect(second.headers.get('x-void-image-cache')).toBe('HIT');
    expect(calls).toHaveLength(1);
    expect(entries.size).toBe(1);
    const head = await hono.fetch(request('url=/test.png&w=64&q=75', {}, 'HEAD'), env, ctx);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('reads a custom binding name from the private runtime var', async () => {
    const { binding, calls } = fakeBinding();
    const raw = { __VOID_IMAGES_BINDING: 'MEDIA', MEDIA: binding, ASSETS: fakeAssets(png).assets };
    const hono = app({ config: config(), deploymentId: 'd1', loadManifest: async () => null });
    // Application handlers see the filtered env; the binding name comes from the raw env.
    const filtered = { MEDIA: binding, ASSETS: raw.ASSETS };
    const response = await withRuntimeEnv(raw, () =>
      hono.fetch(request('url=/test.png&w=64&q=75', { accept: 'image/webp' }), filtered),
    );
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(calls).toHaveLength(1);
  });

  it('runs without an execution context or cache, as on Node targets', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hono = app({ config: config(), deploymentId: 'd1', loadManifest: async () => null });
    const response = await hono.fetch(
      request('url=/test.png&w=64&q=75', { accept: 'image/webp' }),
      {
        ASSETS: fakeAssets(png).assets,
        IMAGES: { input: 'not a binding' },
      },
    );
    // An env value that is not a binding counts as missing (the warning is once per isolate).
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('treats only manifest-proven files below assetsDir as immutable and loads the manifest once', async () => {
    const loadManifest = vi.fn(async () => ({
      'src/hero.png': {
        file: 'static/hero-abc123.png',
        immutableFiles: ['static/hero-abc123.png'],
      },
      'src/other.png': { file: 'other/logo-abc123.png', immutableFiles: ['other/logo-abc123.png'] },
      'src/plain.png': { file: 'static/plain-abc123.png' },
    }));
    const files = {
      '/static/hero-abc123.png': { body: fixture('test.png') },
      '/other/logo-abc123.png': { body: fixture('test.png') },
      '/static/plain-abc123.png': { body: fixture('test.png') },
    };
    const hono = app({ config: config(), deploymentId: 'd1', assetsDir: 'static', loadManifest });
    const env = { ASSETS: fakeAssets(files).assets, IMAGES: fakeBinding().binding };
    const policy = async (path: string): Promise<string | null> =>
      (await hono.fetch(request(`url=${path}&w=64&q=75`), env)).headers.get('cache-control');
    expect(await policy('/static/hero-abc123.png')).toBe('public, max-age=315360000, immutable');
    expect(await policy('/other/logo-abc123.png')).toBe('public, max-age=14400, must-revalidate');
    expect(await policy('/static/plain-abc123.png')).toBe('public, max-age=14400, must-revalidate');
    expect(loadManifest).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit list of fingerprinted files and skips the manifest in development', async () => {
    const loadManifest = vi.fn(async () => null);
    const files = { '/assets/hero-abc123.png': { body: fixture('test.png') } };
    const env = { ASSETS: fakeAssets(files).assets, IMAGES: fakeBinding().binding };
    const query = 'url=/assets/hero-abc123.png&w=64&q=75';
    const production = app({
      config: config(),
      deploymentId: 'd1',
      immutableFiles: ['assets/hero-abc123.png'],
      loadManifest,
    });
    expect((await production.fetch(request(query), env)).headers.get('cache-control')).toBe(
      'public, max-age=315360000, immutable',
    );
    const development = app({ config: config(undefined, true), deploymentId: 'd1', loadManifest });
    expect((await development.fetch(request(query), env)).headers.get('cache-control')).toBe(
      'public, max-age=0, must-revalidate',
    );
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it('treats a manifest that fails to load as proving nothing', async () => {
    const hono = app({
      config: config(),
      deploymentId: 'd1',
      loadManifest: async () => {
        throw new Error('manifest unavailable');
      },
    });
    const files = { '/assets/hero-abc123.png': { body: fixture('test.png') } };
    const response = await hono.fetch(request('url=/assets/hero-abc123.png&w=64&q=75'), {
      ASSETS: fakeAssets(files).assets,
      IMAGES: fakeBinding().binding,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=14400, must-revalidate');
  });
});

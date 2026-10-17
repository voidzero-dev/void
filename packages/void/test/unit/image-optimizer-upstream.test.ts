import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  fetchRemoteImage,
  ImageError,
  loadLocalImage,
  type RemoteImageOptions,
} from '../../src/image/optimizer/index.ts';

const UPSTREAM_INVALID = '"url" parameter is valid but upstream response is invalid';
const INTERNAL_INVALID = '"url" parameter is valid but internal response is invalid';
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

let server: Server;
let handler: (request: IncomingMessage, response: ServerResponse) => void;
let requests: Array<{ url: string; headers: IncomingMessage['headers'] }>;
const origin = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const permissive: RemoteImageOptions = {
  dangerouslyAllowLocalIP: true,
  maximumResponseBody: 50_000_000,
  maximumRedirects: 3,
};

async function failure(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ImageError);
  return { status: (error as ImageError).statusCode, message: (error as ImageError).message };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', headers: request.headers });
    response.on('error', () => {});
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  handler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'image/jpeg' });
    response.end(JPEG);
  };
});

describe('fetchRemoteImage', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])(
    'rejects the private host %s before connecting',
    async (host) => {
      const port = (server.address() as AddressInfo).port;
      expect(
        await failure(
          fetchRemoteImage(`http://${host}:${port}/private.jpg`, {
            ...permissive,
            dangerouslyAllowLocalIP: false,
          }),
        ),
      ).toEqual({ status: 400, message: '"url" parameter is not allowed' });
      expect(requests).toEqual([]);
    },
  );

  it('fetches without client headers and returns type, policy and validator', async () => {
    handler = (_request, response) => {
      response.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=600',
        etag: '"upstream-etag"',
      });
      response.end(Buffer.from([1, 2, 3]));
    };
    const result = await fetchRemoteImage(`${origin()}/headers.png`, permissive);
    expect(result).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      cacheControl: 'public, max-age=600',
      etag: Buffer.from('"upstream-etag"').toString('base64url'),
    });
    expect(requests).toHaveLength(1);
    const { headers } = requests[0];
    expect(headers).toMatchObject({
      accept: '*/*',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
    });
    expect(headers).not.toHaveProperty('cookie');
    expect(headers).not.toHaveProperty('authorization');
  });

  it.each([
    [404, 404],
    [503, 503],
    [399, 500],
  ])('maps upstream status %d to %d', async (status, expected) => {
    handler = (_request, response) => {
      response.writeHead(status);
      response.end('nope');
    };
    expect(await failure(fetchRemoteImage(`${origin()}/status.jpg`, permissive))).toEqual({
      status: expected,
      message: UPSTREAM_INVALID,
    });
  });

  it('rejects an empty body', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end();
    };
    expect(await failure(fetchRemoteImage(`${origin()}/empty.jpg`, permissive))).toEqual({
      status: 400,
      message: UPSTREAM_INVALID,
    });
  });

  it('follows redirects and fails past maximumRedirects', async () => {
    handler = (request, response) => {
      if (request.url === '/redirect.jpg') {
        response.writeHead(302, { location: '/final.jpg' });
        response.end();
        return;
      }
      if (request.url === '/loop.jpg') {
        response.writeHead(307, { location: '/loop.jpg' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(Buffer.from([4, 5, 6]));
    };
    const result = await fetchRemoteImage(`${origin()}/redirect.jpg`, permissive);
    expect(result.bytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(requests.map((request) => request.url)).toEqual(['/redirect.jpg', '/final.jpg']);

    requests = [];
    expect(
      await failure(
        fetchRemoteImage(`${origin()}/redirect.jpg`, { ...permissive, maximumRedirects: 0 }),
      ),
    ).toEqual({ status: 508, message: UPSTREAM_INVALID });
    expect(requests.map((request) => request.url)).toEqual(['/redirect.jpg']);

    requests = [];
    expect(
      await failure(
        fetchRemoteImage(`${origin()}/loop.jpg`, { ...permissive, maximumRedirects: 1 }),
      ),
    ).toEqual({ status: 508, message: UPSTREAM_INVALID });
    expect(requests).toHaveLength(2);
  });

  it('checks every redirect target for a private host without re-reading patterns', async () => {
    const calls: Array<string> = [];
    let cancelled = false;
    let pulls = 0;
    const fetch = async (input: string): Promise<Response> => {
      calls.push(input);
      if (input === 'https://images.test/hop.jpg') {
        return new Response(
          new ReadableStream({
            pull: (controller) => {
              pulls += 1;
              controller.enqueue(new Uint8Array(1024));
            },
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 301, headers: { location: 'https://other.test/final.jpg' } },
        );
      }
      if (input === 'https://images.test/private.jpg') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://[::ffff:7f00:1]/' },
        });
      }
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    };
    const options = { ...permissive, dangerouslyAllowLocalIP: false, fetch };
    expect((await fetchRemoteImage('https://images.test/hop.jpg', options)).bytes).toEqual(
      new Uint8Array(JPEG),
    );
    expect(calls).toEqual(['https://images.test/hop.jpg', 'https://other.test/final.jpg']);
    // The redirect body is cancelled, never drained.
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);

    calls.length = 0;
    expect(await failure(fetchRemoteImage('https://images.test/private.jpg', options))).toEqual({
      status: 400,
      message: '"url" parameter is not allowed',
    });
    expect(calls).toEqual(['https://images.test/private.jpg']);
  });

  it('refuses a redirect target that isAllowedRedirect rejects, before fetching it', async () => {
    const calls: Array<string> = [];
    const checked: Array<string> = [];
    const fetch = async (input: string): Promise<Response> => {
      calls.push(input);
      if (input === 'https://images.test/r?to=metadata') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254.nip.io/latest/meta-data/' },
        });
      }
      if (input === 'https://images.test/r?to=cdn') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.images.test/a.jpg' },
        });
      }
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    };
    const options: RemoteImageOptions = {
      ...permissive,
      dangerouslyAllowLocalIP: false,
      fetch,
      isAllowedRedirect: (url) => {
        checked.push(url.href);
        return url.hostname.endsWith('images.test');
      },
    };
    // A DNS name that resolves to a private address passes the literal-IP check.
    expect(await failure(fetchRemoteImage('https://images.test/r?to=metadata', options))).toEqual({
      status: 400,
      message: '"url" parameter is not allowed',
    });
    expect(calls).toEqual(['https://images.test/r?to=metadata']);
    expect(checked).toEqual(['http://169.254.169.254.nip.io/latest/meta-data/']);

    calls.length = 0;
    expect((await fetchRemoteImage('https://images.test/r?to=cdn', options)).bytes).toEqual(
      new Uint8Array(JPEG),
    );
    expect(calls).toEqual(['https://images.test/r?to=cdn', 'https://cdn.images.test/a.jpg']);
  });

  it.each([
    ['an unparsable location', 'http://[bad', 500],
    ['a non-HTTP location', 'ftp://images.test/a.jpg', 500],
  ])('fails on a redirect with %s', async (_name, location, status) => {
    const fetch = async (): Promise<Response> =>
      new Response(null, { status: 302, headers: { location } });
    expect(
      await failure(fetchRemoteImage('https://images.test/a.jpg', { ...permissive, fetch })),
    ).toEqual({ status, message: UPSTREAM_INVALID });
  });

  it('limits the decoded body and allows exactly the limit', async () => {
    const limit = 2_000;
    handler = (request, response) => {
      response.writeHead(200, {
        'content-type': 'image/jpeg',
        ...(request.url === '/gzip.jpg' ? { 'content-encoding': 'gzip' } : {}),
      });
      if (request.url === '/first-chunk.jpg') {
        response.end(Buffer.alloc(limit + 1));
      } else if (request.url === '/later-chunk.jpg') {
        for (let index = 0; index < 3; index++) {
          response.write(Buffer.alloc(1_000));
        }
        response.end();
      } else if (request.url === '/gzip.jpg') {
        response.end(gzipSync(Buffer.alloc(limit + 1)));
      } else {
        response.write(Buffer.alloc(1_000));
        response.end(Buffer.alloc(1_000));
      }
    };
    const options = { ...permissive, maximumResponseBody: limit };
    for (const path of ['/first-chunk.jpg', '/later-chunk.jpg', '/gzip.jpg']) {
      expect(await failure(fetchRemoteImage(`${origin()}${path}`, options))).toEqual({
        status: 413,
        message: UPSTREAM_INVALID,
      });
    }
    expect((await fetchRemoteImage(`${origin()}/exact.jpg`, options)).bytes.byteLength).toBe(limit);
  });

  it('times out before the headers and during the body', async () => {
    handler = (request, response) => {
      if (request.url === '/stalled-body.jpg') {
        response.writeHead(200, { 'content-type': 'image/jpeg' });
        response.write(Buffer.from([0xff, 0xd8]));
      }
      // `/stalled-headers.jpg` is never answered.
    };
    const options = { ...permissive, timeoutMs: 150 };
    const timedOut = {
      status: 504,
      message: '"url" parameter is valid but upstream response timed out',
    };
    const [beforeHeaders, duringBody] = await Promise.all([
      failure(fetchRemoteImage(`${origin()}/stalled-headers.jpg`, options)),
      failure(fetchRemoteImage(`${origin()}/stalled-body.jpg`, options)),
    ]);
    expect({ beforeHeaders, duringBody }).toEqual({
      beforeHeaders: timedOut,
      duringBody: timedOut,
    });
  });

  it('reports a connection failure as an invalid upstream response', async () => {
    const fetch = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    expect(
      await failure(fetchRemoteImage('https://images.test/a.jpg', { ...permissive, fetch })),
    ).toEqual({ status: 500, message: UPSTREAM_INVALID });
  });
});

describe('loadLocalImage', () => {
  it('loads a static asset with an empty GET request', async () => {
    const seen: Array<Request> = [];
    const assets = {
      fetch: async (request: Request): Promise<Response> => {
        seen.push(request);
        return new Response(JPEG, {
          headers: {
            'content-type': 'image/jpeg',
            'cache-control': 'public, max-age=0',
            etag: 'W/"1"',
          },
        });
      },
    };
    const result = await loadLocalImage(
      assets,
      '/my photo.jpg?x=1',
      'https://app.test/_void/image?url=x',
      100,
    );
    expect(result).toEqual({
      bytes: new Uint8Array(JPEG),
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=0',
      etag: Buffer.from('W/"1"').toString('base64url'),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toBe('https://app.test/my%20photo.jpg?x=1');
    expect([...seen[0].headers]).toEqual([]);
  });

  it.each<[string, () => Response, { status: number; message: string }]>([
    [
      'a missing file',
      () => new Response('missing', { status: 404 }),
      { status: 404, message: INTERNAL_INVALID },
    ],
    [
      'a redirect',
      () => new Response(null, { status: 307, headers: { location: '/other.png' } }),
      { status: 500, message: INTERNAL_INVALID },
    ],
    ['an empty body', () => new Response(null), { status: 400, message: INTERNAL_INVALID }],
    [
      'an oversized body',
      () => new Response(new Uint8Array(11)),
      { status: 413, message: INTERNAL_INVALID },
    ],
  ])('rejects %s', async (_name, response, expected) => {
    expect(
      await failure(
        loadLocalImage({ fetch: async () => response() }, '/a.png', 'https://app.test/', 10),
      ),
    ).toEqual(expected);
  });

  describe('through the app', () => {
    const image = (): Response =>
      new Response(JPEG, { headers: { 'content-type': 'image/jpeg', etag: '"app"' } });
    function setup(answer: (request: Request) => Response | Promise<Response>) {
      const dispatched: Array<Request> = [];
      const read: Array<Request> = [];
      return {
        dispatched,
        read,
        dispatch: async (request: Request): Promise<Response> => {
          dispatched.push(request);
          return answer(request);
        },
        assets: {
          fetch: async (request: Request): Promise<Response> => {
            read.push(request);
            return image();
          },
        },
      };
    }

    it('fails with the status of a guard and never reads the asset', async () => {
      const { dispatch, assets, dispatched, read } = setup(
        () => new Response('Unauthorized', { status: 401 }),
      );
      expect(
        await failure(
          loadLocalImage(assets, '/members/a.png', 'https://app.test/_void/image', 100, dispatch),
        ),
      ).toEqual({ status: 401, message: INTERNAL_INVALID });
      expect(read).toEqual([]);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].method).toBe('GET');
      expect(dispatched[0].url).toBe('https://app.test/members/a.png');
      expect([...dispatched[0].headers]).toEqual([]);
    });

    it('fails on a redirect from the app', async () => {
      const { dispatch, assets, read } = setup(
        () => new Response(null, { status: 302, headers: { location: '/login' } }),
      );
      expect(
        await failure(loadLocalImage(assets, '/a.png', 'https://app.test/', 100, dispatch)),
      ).toEqual({ status: 500, message: INTERNAL_INVALID });
      expect(read).toEqual([]);
    });

    it('falls back to the static assets when the app answers 404', async () => {
      const { dispatch, assets, read } = setup(() => new Response('none', { status: 404 }));
      const result = await loadLocalImage(assets, '/a.png', 'https://app.test/', 100, dispatch);
      expect(result.bytes).toEqual(new Uint8Array(JPEG));
      expect(read.map((request) => request.url)).toEqual(['https://app.test/a.png']);
      expect([...read[0].headers]).toEqual([]);
    });

    it('uses what the app serves, as page fallbacks serve static files', async () => {
      const { dispatch, assets, read } = setup(image);
      const result = await loadLocalImage(assets, '/a.png', 'https://app.test/', 100, dispatch);
      expect(result.etag).toBe(Buffer.from('"app"').toString('base64url'));
      expect(read).toEqual([]);
    });

    it('passes an app 404 through without assets and maps a throw to 500', async () => {
      const notFound = async (): Promise<Response> => new Response('none', { status: 404 });
      expect(
        await failure(loadLocalImage(undefined, '/a.png', 'https://app.test/', 100, notFound)),
      ).toEqual({ status: 404, message: INTERNAL_INVALID });
      const broken = async (): Promise<Response> => {
        throw new Error('boom');
      };
      expect(
        await failure(loadLocalImage(undefined, '/a.png', 'https://app.test/', 100, broken)),
      ).toEqual({ status: 500, message: UPSTREAM_INVALID });
    });
  });

  it('fails without an assets binding or when it throws', async () => {
    expect(await failure(loadLocalImage(undefined, '/a.png', 'https://app.test/', 10))).toEqual({
      status: 500,
      message: UPSTREAM_INVALID,
    });
    const assets = {
      fetch: async (): Promise<Response> => {
        throw new Error('boom');
      },
    };
    expect(await failure(loadLocalImage(assets, '/a.png', 'https://app.test/', 10))).toEqual({
      status: 500,
      message: UPSTREAM_INVALID,
    });
  });
});

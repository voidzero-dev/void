import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformClient } from '../../src/cli/client.ts';
import {
  isPlatformDiscoveryRequest,
  platformDiscoveryResponse,
  type PlatformDiscoveryFeatures,
} from '../helpers/platform-discovery.ts';

// Never read the keychain or run cloudflared. Without Access credentials, an
// Access challenge fails the way it does for a CLI that has none.
vi.mock('../../src/cli/cf-access.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/cf-access.ts')>()),
  ensurePlatformAccessToken: vi.fn((_apiUrl: string, challenged?: boolean) => {
    if (challenged) {
      throw new Error('platform: Cloudflare Access authentication is required.');
    }
  }),
}));

// Version checks are cached per process and base URL, so each test uses its own origin.
let origin = '';
let sequence = 0;
const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  origin = `https://platform-${++sequence}.example.test`;
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function serve(platformVersion: string | (() => Response | Promise<Response>)): void {
  fetchMock.mockImplementation(async (input: string) => {
    if (isPlatformDiscoveryRequest(input)) {
      return typeof platformVersion === 'string'
        ? platformDiscoveryResponse(input, platformVersion)
        : platformVersion();
    }
    return Response.json([]);
  });
}

function requestedPaths(): Array<string> {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
}

function client(options: { checkPlatformVersion?: boolean } = {}): PlatformClient {
  return new PlatformClient('token', { apiUrl: origin, ...options });
}

describe('minimum platform version', () => {
  it.each(['1.1.11', '1.2.0', '2.0.0', 'hosted'])(
    'accepts a platform reporting %s',
    async (version) => {
      serve(version);
      await expect(client().listProjectChoices()).resolves.toEqual([]);
      expect(requestedPaths()).toEqual(['/.well-known/void-platform', '/projects/choices']);
    },
  );

  it('sends discovery without the account token', async () => {
    serve('1.1.11');
    await client().listProjectChoices();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it.each(['1.1.0', '1.1.9', '1.1.11-1'])('refuses a platform reporting %s', async (version) => {
    serve(version);
    await expect(client().listProjectChoices()).rejects.toThrow(
      `The Void platform at ${origin} runs version ${version}, but this CLI requires 1.1.11 or later. Ask its administrator to upgrade the platform runtime with \`void platform upgrade\`.`,
    );
    expect(requestedPaths()).toEqual(['/.well-known/void-platform']);
  });

  it('checks once per process and base URL, sharing a concurrent first check', async () => {
    serve('1.1.11');
    await Promise.all([client().listProjectChoices(), client().listProjects()]);
    await client().listProjectChoices();
    expect(requestedPaths().filter((path) => path === '/.well-known/void-platform')).toHaveLength(
      1,
    );
    expect(requestedPaths()).toHaveLength(4);

    const other = `https://other-${sequence}.example.test`;
    await new PlatformClient('token', { apiUrl: other }).listProjects();
    expect(fetchMock.mock.calls.at(-2)?.[0]).toBe(`${other}/.well-known/void-platform`);
  });

  it('does not check when login opts out', async () => {
    serve('0.22.0');
    await expect(client({ checkPlatformVersion: false }).listProjectChoices()).resolves.toEqual([]);
    expect(requestedPaths()).toEqual(['/projects/choices']);
  });

  it('refuses a too-old platform once and keeps the answer for later requests', async () => {
    serve('0.22.0');
    await expect(client().listProjectChoices()).rejects.toThrow('runs version 0.22.0');
    await expect(client().listProjects()).rejects.toThrow('runs version 0.22.0');
    expect(requestedPaths()).toEqual(['/.well-known/void-platform']);
  });

  it.each([
    ['an HTML 404', () => new Response('<html>not found</html>', { status: 404 })],
    ['a JSON 404', () => Response.json({ error: 'not found' }, { status: 404 })],
  ])('refuses a platform that answers discovery with %s', async (_label, answer) => {
    serve(answer);
    const message = `The Void platform at ${origin} does not report its version, but this CLI requires 1.1.11 or later. Ask its administrator to upgrade the platform runtime with \`void platform upgrade\`.`;
    await expect(client().listProjectChoices()).rejects.toThrow(message);
    await expect(client().listProjects()).rejects.toThrow(message);
    expect(requestedPaths()).toEqual(['/.well-known/void-platform']);
  });

  it.each([
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'a timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
    [
      'a disabled platform (503)',
      () => Response.json({ error: 'platform disabled' }, { status: 503 }),
    ],
    [
      'an Access login redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' },
        }),
    ],
    ['invalid JSON', () => new Response('not json', { status: 200 })],
  ])(
    'lets the request run once discovery gives %s, and does not probe again',
    async (_label, answer) => {
      serve(answer);
      await expect(client().listProjectChoices()).resolves.toEqual([]);
      await expect(client().listProjects()).resolves.toEqual([]);
      expect(requestedPaths()).toEqual([
        '/.well-known/void-platform',
        '/projects/choices',
        '/projects',
      ]);
    },
  );

  it('accepts a version it cannot order', async () => {
    serve('development');
    await expect(client().listProjectChoices()).resolves.toEqual([]);
  });
});

describe('direct Worker upload discovery', () => {
  function serveFeatures(features: PlatformDiscoveryFeatures): void {
    serve(() => platformDiscoveryResponse(origin, undefined, features));
  }

  it.each([
    ['true', { directWorkerUpload: true }, true],
    ['false', { directWorkerUpload: false }, false],
    ['absent, as on an older platform', {}, false],
  ])('reports support only when discovery says so (%s)', async (_label, features, expected) => {
    serveFeatures(features);
    await expect(client().supportsDirectWorkerUpload()).resolves.toBe(expected);
  });

  it('reuses the version check probe', async () => {
    serveFeatures({ directWorkerUpload: true });
    await client().listProjectChoices();
    await expect(client().supportsDirectWorkerUpload()).resolves.toBe(true);
    expect(requestedPaths()).toEqual(['/.well-known/void-platform', '/projects/choices']);
  });

  it.each([
    ['a disabled platform (503)', () => Response.json({ error: 'disabled' }, { status: 503 })],
    [
      'an invalid field',
      () => platformDiscoveryResponse(origin, undefined, { directWorkerUpload: 'yes' }),
    ],
  ])(
    'reports no support when discovery gives %s, and lets requests run',
    async (_label, answer) => {
      serve(answer);
      await expect(client().supportsDirectWorkerUpload()).resolves.toBe(false);
      await expect(client().listProjectChoices()).resolves.toEqual([]);
    },
  );

  it('asks discovery again when the cached answer was inconclusive', async () => {
    let probes = 0;
    serve(() =>
      ++probes === 1
        ? Response.json({ error: 'unavailable' }, { status: 503 })
        : platformDiscoveryResponse(origin, undefined, { directWorkerUpload: true }),
    );
    await client().listProjectChoices();
    await expect(client().supportsDirectWorkerUpload()).resolves.toBe(true);
    // The version check keeps its first outcome.
    await client().listProjects();
    expect(requestedPaths()).toEqual([
      '/.well-known/void-platform',
      '/projects/choices',
      '/.well-known/void-platform',
      '/projects',
    ]);
  });

  it('reports no support when discovery stays inconclusive', async () => {
    serve(() => Response.json({ error: 'unavailable' }, { status: 503 }));
    await client().listProjectChoices();
    await expect(client().supportsDirectWorkerUpload()).resolves.toBe(false);
    expect(requestedPaths()).toEqual([
      '/.well-known/void-platform',
      '/projects/choices',
      '/.well-known/void-platform',
    ]);
  });

  it('does not ask again when discovery omits the field', async () => {
    serveFeatures({});
    await client().listProjectChoices();
    await expect(client().supportsDirectWorkerUpload()).resolves.toBe(false);
    expect(requestedPaths()).toEqual(['/.well-known/void-platform', '/projects/choices']);
  });
});

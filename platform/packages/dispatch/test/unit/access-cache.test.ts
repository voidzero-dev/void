import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { ProjectAccessVerifier, projectAccessVerifier } from '../../src/access.ts';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';
import {
  isrCacheKey,
  isrEdgeCacheKey,
  packIsrValue,
  SHARED_CACHE_POLICY_HEADER,
  SHARED_CACHE_POLICY_VERSION,
} from '../../src/isr.ts';

const teamDomain = 'https://company.cloudflareaccess.com';
const protection = {
  teamDomain,
  audiences: [{ hostname: '*.void.app', audience: 'project-audience' }],
};
let jwk: Record<string, unknown>;
let assertions: Record<'alice' | 'bob', string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'access-cache', use: 'sig' };
  const sign = (subject: string) =>
    new SignJWT({ type: 'app' })
      .setSubject(subject)
      .setIssuer(teamDomain)
      .setAudience('project-audience')
      .setIssuedAt()
      .setExpirationTime('10m')
      .setProtectedHeader({ alg: 'RS256', kid: 'access-cache' })
      .sign(privateKey);
  assertions = { alice: await sign('alice'), bob: await sign('bob') };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createHarness(mode: 'hashed' | 'isr') {
  const edgeEntries = new Map<string, Response>();
  const edgeCache = {
    match: vi.fn(async (request: Request) => edgeEntries.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      edgeEntries.set(request.url, response.clone());
    }),
    delete: vi.fn(async (request: Request) => edgeEntries.delete(request.url)),
  };
  vi.stubGlobal('caches', { default: edgeCache });
  const isrEntries = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
  const isrCache = {
    get: vi.fn(async (key: string) => {
      const entry = isrEntries.get(key.slice('isr-cache/'.length));
      return entry
        ? {
            arrayBuffer: async () => entry.value,
            customMetadata: { isr: JSON.stringify(entry.metadata) },
          }
        : null;
    }),
    put: vi.fn(
      async (key: string, value: ArrayBuffer, options: { customMetadata: { isr: string } }) => {
        isrEntries.set(key.slice('isr-cache/'.length), {
          value,
          metadata: JSON.parse(options.customMetadata.isr),
        });
      },
    ),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
  };
  const origin = vi.fn(async (request: Request) => {
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    const subject = assertion ? decodeJwt(assertion).sub : 'anonymous';
    // The app personalizes its response without sending any cache opt-out.
    return new Response(`profile: ${subject}`, {
      headers: { 'Content-Type': mode === 'isr' ? 'text/html' : 'application/json' },
    });
  });
  const routing = {
    workerName: 'user-profile-deployment',
    projectId: 'project-profile',
    version: 'deployment',
    ...(mode === 'hashed'
      ? { hashedAssetsPrefix: 'assets' }
      : { ssr: true, pages: [{ pattern: '/profile', revalidate: 60 }] }),
    zeroTrust: undefined as typeof protection | undefined,
  };
  const env = {
    ROUTING: { get: async () => JSON.stringify(routing) },
    DISPATCH: { get: () => ({ fetch: origin }) },
    STATIC_ASSETS_R2: isrCache,
    ISR_CACHE: { delete: async () => {} },
    ANALYTICS: { writeDataPoint() {} },
  } as unknown as Env;
  const url = `https://profile.void.app${mode === 'hashed' ? '/assets/profile-a1.json' : '/profile'}`;
  const request = async (subject?: keyof typeof assertions) => {
    const work: Array<Promise<unknown>> = [];
    const response = await app.fetch(
      new Request(url, {
        headers: subject ? { 'Cf-Access-Jwt-Assertion': assertions[subject] } : {},
      }),
      env,
      {
        waitUntil: (promise: Promise<unknown>) => work.push(promise),
      } as unknown as ExecutionContext,
    );
    await Promise.all(work);
    return response;
  };
  return { edgeEntries, edgeCache, isrEntries, isrCache, origin, routing, request, url };
}

describe.each(['hashed', 'isr'] as const)('Access assertion isolation for %s responses', (mode) => {
  it.each(['empty', 'populated'] as const)(
    'bypasses all shared cache reads and writes with %s caches',
    async (cacheState) => {
      const { edgeEntries, edgeCache, isrCache, origin, routing, request } = createHarness(mode);
      if (cacheState === 'populated') {
        expect(await (await request()).text()).toBe('profile: anonymous');
        expect(edgeEntries.size).toBe(1);
        vi.clearAllMocks();
      }
      routing.zeroTrust = protection;
      const signingKeys = vi.fn(async () => Response.json({ keys: [jwk] }));
      const verifier = new ProjectAccessVerifier(signingKeys as typeof fetch);
      const verify = vi
        .spyOn(projectAccessVerifier, 'verify')
        .mockImplementation(verifier.verify.bind(verifier));

      for (const subject of ['alice', 'bob'] as const) {
        const response = await request(subject);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`profile: ${subject}`);
        expect(response.headers.get('x-isr-cache')).toBeNull();
      }
      expect(verify).toHaveBeenCalledTimes(2);
      expect(signingKeys).toHaveBeenCalledOnce();
      expect(origin).toHaveBeenCalledTimes(2);
      for (const [request] of origin.mock.calls) {
        expect(request.headers.has('Cookie')).toBe(false);
        expect(request.headers.has('Authorization')).toBe(false);
      }
      for (const operation of [...Object.values(edgeCache), ...Object.values(isrCache)]) {
        expect(operation).not.toHaveBeenCalled();
      }
      expect(edgeEntries.size).toBe(cacheState === 'populated' ? 1 : 0);
      for (const cached of edgeEntries.values()) {
        expect(await cached.clone().text()).toBe('profile: anonymous');
      }
    },
  );

  it('still shares public responses without credentials', async () => {
    const { edgeCache, isrCache, origin, request } = createHarness(mode);

    expect(await (await request()).text()).toBe('profile: anonymous');
    expect(await (await request()).text()).toBe('profile: anonymous');

    expect(origin).toHaveBeenCalledOnce();
    expect(edgeCache.match).toHaveBeenCalledTimes(2);
    expect(edgeCache.put).toHaveBeenCalledOnce();
    expect(isrCache.get).toHaveBeenCalledTimes(mode === 'isr' ? 1 : 0);
    expect(isrCache.put).toHaveBeenCalledTimes(mode === 'isr' ? 1 : 0);
  });

  it('replaces edge responses admitted before Access assertions bypassed caching', async () => {
    const { edgeEntries, origin, request, routing, url } = createHarness(mode);
    const key =
      mode === 'hashed'
        ? `${url}?_p=${routing.projectId}`
        : isrEdgeCacheKey(new Request(url), '/profile', 'deployment').url;
    edgeEntries.set(
      key,
      new Response('profile: alice', {
        headers: {
          'Content-Type': mode === 'isr' ? 'text/html' : 'application/json',
          'Cache-Control': 'public, max-age=60',
          [SHARED_CACHE_POLICY_HEADER]: '1',
          ...(mode === 'isr' ? { 'x-isr-cache': 'HIT' } : {}),
        },
      }),
    );

    expect(await (await request()).text()).toBe('profile: anonymous');
    expect(origin).toHaveBeenCalledOnce();
    expect(await edgeEntries.get(key)!.clone().text()).toBe('profile: anonymous');
    expect(edgeEntries.get(key)!.headers.get(SHARED_CACHE_POLICY_HEADER)).toBe(
      String(SHARED_CACHE_POLICY_VERSION),
    );
  });
});

it('replaces ISR storage responses admitted before Access assertions bypassed caching', async () => {
  const { isrEntries, isrCache, origin, request } = createHarness('isr');
  const key = isrCacheKey('project-profile', 'deployment', 'profile.void.app', '/profile');
  isrEntries.set(key, {
    value: packIsrValue(
      { 'content-type': 'text/html' },
      new TextEncoder().encode('profile: alice').buffer as ArrayBuffer,
    ),
    metadata: { s: 200, c: Date.now(), t: 60, p: 1 },
  });

  expect(await (await request()).text()).toBe('profile: anonymous');
  expect(origin).toHaveBeenCalledOnce();
  expect(isrCache.get).toHaveBeenCalledOnce();
  expect(isrCache.put).toHaveBeenCalledOnce();
  expect(isrEntries.get(key)!.metadata).toMatchObject({ p: SHARED_CACHE_POLICY_VERSION });
});

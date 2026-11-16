import { createHmac, hkdfSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import { signJwt } from '../../src/auth/jwt.ts';
import {
  createProxyTokenStateCache,
  deriveAiUsageTag,
  deriveProxyInternalAuth,
  deriveProxyToken,
  isAcceptedGeneration,
  LEGACY_PROXY_TOKEN_STATE,
  parseProxyTokenState,
  PROXY_INTERNAL_AUTH_HEADER,
  PROXY_TOKEN_ISOLATE_TTL_MS,
  PROXY_TOKEN_KV_CACHE_TTL_SECONDS,
  type ProxyInternalRoute,
  proxyTokenGeneration,
  proxyTokenStateKey,
  type ProxyTokenState,
  ProxyTokenStateError,
  readProxyTokenState,
  serializeProxyTokenState,
  verifyProxyInternalAuth,
  verifyProxyToken,
} from '../../src/proxy-token.ts';

const SECRET = 'test-secret-key';
const PROJECT = 'proj_000000000001';
const OTHER_PROJECT = 'proj_000000000002';

const TOK_0 = 'ZMRzpVRsaOJSG_unVlA0oqSaz2kApOohvao_XGR8Q0c';
const TOK_1 = '1.tSB1ya3fUJXjnL2nfUht0aCBRh9d1pFCrH_rJIJGGWo';
const TOK_2 = '2.Ko4ZEz_VQ8IZH70koONArHkURyEHZUwLJsqFsGJgwyE';
const INTERNAL: Record<ProxyInternalRoute, string> = {
  'resolve-worker': 'Phjba6joMrR31HPBsOamhNdtbT3__9Fg6zkd34dJiS0',
  'resolve-resource': 'qqnenNPCqY-C4RMAfPn0AUdXlvKS0tvkDcC8lyjTYck',
  'verify-prerender-build': 'L-_KXs8KdULytY5ibjHuH095R-1L3OM91NokMoj6828',
  'ai-logging': 'wrzsGDsBbCmnE9y7-oiaKILziYTHDffhfKqUGvpBQpM',
};
const ROUTES = Object.keys(INTERNAL) as Array<ProxyInternalRoute>;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function nodeTok(gen: number, projectId = PROJECT): string {
  if (gen === 0) {
    return base64url(createHmac('sha256', SECRET).update(projectId).digest());
  }
  const key = Buffer.from(hkdfSync('sha256', SECRET, 'void-proxy-token', 'proxy-token', 32));
  const mac = createHmac('sha256', key).update(`void-proxy-token:${projectId}:${gen}`).digest();
  return `${gen}.${base64url(mac)}`;
}

function nodeInternal(route: ProxyInternalRoute, projectId = PROJECT): string {
  const key = Buffer.from(hkdfSync('sha256', SECRET, 'void-proxy-internal', 'proxy-internal', 32));
  return base64url(
    createHmac('sha256', key).update(`void-proxy-internal\n${route}\n${projectId}`).digest(),
  );
}

function nodeAiUsageTag(projectId: string, secret = SECRET): string {
  const key = Buffer.from(hkdfSync('sha256', secret, 'void-ai-usage', 'ai-usage', 32));
  const mac = base64url(createHmac('sha256', key).update(`void-ai-usage\n${projectId}`).digest());
  return `${projectId}.${mac.slice(0, 22)}`;
}

function kvStub(values: Record<string, string> = {}) {
  const get = vi.fn(async (key: string, _options?: unknown) => values[key] ?? null);
  return { routing: { get } as unknown as Pick<KVNamespace, 'get'>, get, values };
}

function throwingKv() {
  const get = vi.fn(async () => {
    throw new Error('kv down');
  });
  return { routing: { get } as unknown as Pick<KVNamespace, 'get'>, get };
}

function verify(token: string, state: ProxyTokenState | Error = LEGACY_PROXY_TOKEN_STATE) {
  const readState = vi.fn(async () => {
    if (state instanceof Error) {
      throw state;
    }
    return state;
  });
  return {
    readState,
    result: verifyProxyToken({ jwtSecret: SECRET, projectId: PROJECT, token, readState }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('vectors', () => {
  it.each([
    [0, TOK_0],
    [1, TOK_1],
    [2, TOK_2],
  ])('derives tok(%i)', async (gen, expected) => {
    const token = await deriveProxyToken(SECRET, PROJECT, gen);
    expect(token).toBe(expected);
    expect(token).toBe(nodeTok(gen));
  });

  it('keeps the legacy token byte-identical to hmacSignState', async () => {
    expect(await deriveProxyToken(SECRET, PROJECT, 0)).toBe(await hmacSignState(PROJECT, SECRET));
    expect(TOK_0).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each(ROUTES)('derives the internal value for %s', async (route) => {
    const value = await deriveProxyInternalAuth(SECRET, route, PROJECT);
    expect(value).toBe(INTERNAL[route]);
    expect(value).toBe(nodeInternal(route));
  });

  it('keeps internal values distinct from each other and from tenant tokens', () => {
    const values = [...Object.values(INTERNAL), TOK_0, TOK_1.slice('1.'.length)];
    expect(new Set(values).size).toBe(values.length);
  });

  it('names the proxy internal header', () => {
    expect(PROXY_INTERNAL_AUTH_HEADER).toBe('x-void-proxy-internal');
  });
});

describe('parseProxyTokenState', () => {
  it.each([
    [null, 0],
    [undefined, 0],
    ['{"gen":0}', 0],
    ['{"gen":3}', 3],
    ['{"gen":3,"next":4}', 3],
  ])('parses %j', (raw, gen) => {
    expect(parseProxyTokenState(raw)).toEqual({ gen });
  });

  it.each([
    'not json',
    '[]',
    'null',
    '{"gen":-1}',
    '{"gen":1.5}',
    '{"gen":"1"}',
    '{"next":1}',
    `{"gen":${Number.MAX_SAFE_INTEGER}}`,
  ])('throws for %s', (raw) => {
    expect(() => parseProxyTokenState(raw)).toThrow(ProxyTokenStateError);
  });

  it('serializes a state that parses back', () => {
    expect(serializeProxyTokenState({ gen: 4 })).toBe('{"gen":4}');
    expect(parseProxyTokenState(serializeProxyTokenState({ gen: 4 }))).toEqual({ gen: 4 });
    expect(() => serializeProxyTokenState({ gen: -1 })).toThrow(ProxyTokenStateError);
  });

  it('keys the state by project id', () => {
    expect(proxyTokenStateKey(PROJECT)).toBe('proxy-token:proj_000000000001');
  });
});

describe('state table', () => {
  it.each([
    { raw: null, accepted: [0, 1, 5], rejected: [] },
    { raw: '{"gen":0}', accepted: [0, 1, 5], rejected: [] },
    { raw: '{"gen":1}', accepted: [1, 2], rejected: [0] },
    { raw: '{"gen":2}', accepted: [2, 3], rejected: [0, 1] },
    { raw: '{"gen":3}', accepted: [3, 4], rejected: [0, 1, 2] },
  ])('floor $raw', async ({ raw, accepted, rejected }) => {
    const { routing } = kvStub(raw === null ? {} : { [proxyTokenStateKey(PROJECT)]: raw });
    const state = await readProxyTokenState(routing, PROJECT);
    for (const gen of accepted) {
      expect(isAcceptedGeneration(state, gen)).toBe(true);
      expect(await verify(await deriveProxyToken(SECRET, PROJECT, gen), state).result).toBe(true);
    }
    for (const gen of rejected) {
      expect(isAcceptedGeneration(state, gen)).toBe(false);
      expect(await verify(await deriveProxyToken(SECRET, PROJECT, gen), state).result).toBe(false);
    }
  });

  it('fails closed on a malformed floor', async () => {
    const { routing } = kvStub({ [proxyTokenStateKey(PROJECT)]: '{"gen":"x"}' });
    await expect(readProxyTokenState(routing, PROJECT)).rejects.toThrow(ProxyTokenStateError);
  });
});

describe('verifyProxyToken', () => {
  it('accepts the legacy and generation tokens when no floor is set', async () => {
    expect(await verify(TOK_0).result).toBe(true);
    expect(await verify(TOK_1).result).toBe(true);
  });

  it('accepts generations at or above the floor only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await verify(TOK_2, { gen: 2 }).result).toBe(true);
    expect(await verify(await deriveProxyToken(SECRET, PROJECT, 3), { gen: 2 }).result).toBe(true);
    expect(await verify(TOK_1, { gen: 2 }).result).toBe(false);
    expect(await verify(TOK_0, { gen: 2 }).result).toBe(false);
    expect(warn).toHaveBeenCalledWith('[proxy-token] rejected generation', {
      projectId: PROJECT,
      gen: 1,
      floor: 2,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOK_1);
  });

  it("rejects another project's token", async () => {
    expect(await verify(await deriveProxyToken(SECRET, OTHER_PROJECT, 1)).result).toBe(false);
    expect(await verify(await deriveProxyToken(SECRET, OTHER_PROJECT, 0)).result).toBe(false);
  });

  it('rejects a MAC relabelled with another generation', async () => {
    const relabelled = `2.${TOK_1.slice('1.'.length)}`;
    const { result, readState } = verify(relabelled);
    expect(await result).toBe(false);
    expect(readState).not.toHaveBeenCalled();
  });

  it('rejects a bad MAC without reading the floor', async () => {
    const badMac = `1.${'A'.repeat(43)}`;
    for (const token of [badMac, 'A'.repeat(43)]) {
      const { result, readState } = verify(token);
      expect(await result).toBe(false);
      expect(readState).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['generation zero in the dotted form', `0.${TOK_1.slice('1.'.length)}`],
    ['leading zero generation', `01.${TOK_1.slice('1.'.length)}`],
    ['leading zero and short MAC', '01.x'],
    ['42-char MAC', TOK_0.slice(0, 42)],
    ['44-char MAC', `${TOK_0}A`],
    ['trailing padding', `${TOK_0}=`],
    ['standard base64 alphabet', `+${TOK_0.slice(1)}`],
    ['empty token', ''],
    ['unsafe generation', `9999999999999999.${TOK_1.slice('1.'.length)}`],
  ])('rejects a malformed token (%s) without reading the floor', async (_name, token) => {
    const { result, readState } = verify(token);
    expect(await result).toBe(false);
    expect(readState).not.toHaveBeenCalled();
  });

  it('propagates a state error after a valid MAC', async () => {
    await expect(verify(TOK_1, new ProxyTokenStateError('down')).result).rejects.toThrow(
      ProxyTokenStateError,
    );
  });

  it('rejects a login JWT split into project id and token', async () => {
    const jwt = await signJwt({ sub: 'user_1', login: 'octocat', aud: 'api' }, SECRET);
    const [header, body, signature] = jwt.split('.');
    const projectId = `${header}.${body}`;
    // The JWT signature is the legacy MAC over this string.
    expect(await hmacSignState(projectId, SECRET)).toBe(signature);
    expect(await proxyTokenGeneration(SECRET, projectId, signature)).toBeNull();
    const readState = vi.fn(async () => LEGACY_PROXY_TOKEN_STATE);
    expect(
      await verifyProxyToken({ jwtSecret: SECRET, projectId, token: signature, readState }),
    ).toBe(false);
    expect(readState).not.toHaveBeenCalled();
  });
});

describe('proxyTokenGeneration', () => {
  it('returns the generation of a valid token', async () => {
    expect(await proxyTokenGeneration(SECRET, PROJECT, TOK_0)).toBe(0);
    expect(await proxyTokenGeneration(SECRET, PROJECT, TOK_2)).toBe(2);
    expect(await proxyTokenGeneration('other-secret', PROJECT, TOK_2)).toBeNull();
  });
});

describe('deriveProxyToken', () => {
  it.each([
    ['a non-project id', 'proj_1', 1],
    ['a negative generation', PROJECT, -1],
    ['a fractional generation', PROJECT, 1.5],
  ])('throws for %s', async (_name, projectId, gen) => {
    await expect(deriveProxyToken(SECRET, projectId, gen)).rejects.toThrow();
  });
});

describe('readProxyTokenState', () => {
  it('passes cacheTtl through only when given', async () => {
    const { routing, get } = kvStub({ [proxyTokenStateKey(PROJECT)]: '{"gen":1}' });
    expect(await readProxyTokenState(routing, PROJECT, { cacheTtl: 30 })).toEqual({ gen: 1 });
    expect(get).toHaveBeenLastCalledWith('proxy-token:proj_000000000001', { cacheTtl: 30 });
    await readProxyTokenState(routing, PROJECT);
    expect(get).toHaveBeenLastCalledWith('proxy-token:proj_000000000001');
  });

  it('wraps a KV error', async () => {
    const { routing } = throwingKv();
    const error = await readProxyTokenState(routing, PROJECT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProxyTokenStateError);
    expect((error as Error).cause).toEqual(new Error('kv down'));
  });

  it('pins the timing constants', () => {
    expect(PROXY_TOKEN_KV_CACHE_TTL_SECONDS).toBe(30);
    expect(PROXY_TOKEN_ISOLATE_TTL_MS).toBe(15_000);
  });
});

describe('createProxyTokenStateCache', () => {
  function clock() {
    let time = 1_000_000;
    return {
      now: () => time,
      advance(ms: number) {
        time += ms;
      },
    };
  }

  it('caches a missing key and re-reads after the isolate TTL', async () => {
    const time = clock();
    const cache = createProxyTokenStateCache({ now: time.now });
    const { routing, get, values } = kvStub();

    expect(await cache.read(routing, PROJECT)).toEqual({ gen: 0 });
    expect(await cache.read(routing, PROJECT)).toEqual({ gen: 0 });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('proxy-token:proj_000000000001', {
      cacheTtl: PROXY_TOKEN_KV_CACHE_TTL_SECONDS,
    });

    values[proxyTokenStateKey(PROJECT)] = '{"gen":2}';
    time.advance(PROXY_TOKEN_ISOLATE_TTL_MS - 1);
    expect(await cache.read(routing, PROJECT)).toEqual({ gen: 0 });
    time.advance(1);
    expect(await cache.read(routing, PROJECT)).toEqual({ gen: 2 });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry past the size bound', async () => {
    const cache = createProxyTokenStateCache({ now: clock().now });
    const { routing, get } = kvStub();
    const ids = Array.from({ length: 1001 }, (_, i) => `proj_${String(i).padStart(12, '0')}`);
    for (const id of ids) {
      await cache.read(routing, id);
    }
    expect(get).toHaveBeenCalledTimes(1001);
    await cache.read(routing, ids[1000]);
    await cache.read(routing, ids[1]);
    expect(get).toHaveBeenCalledTimes(1001);
    await cache.read(routing, ids[0]);
    expect(get).toHaveBeenCalledTimes(1002);
  });

  it('does not serve an expired entry or cache an error when KV fails', async () => {
    const time = clock();
    const cache = createProxyTokenStateCache({ now: time.now });
    const { routing, get, values } = kvStub({ [proxyTokenStateKey(PROJECT)]: '{"gen":1}' });
    expect(await cache.read(routing, PROJECT)).toEqual({ gen: 1 });

    time.advance(PROXY_TOKEN_ISOLATE_TTL_MS);
    get.mockRejectedValueOnce(new Error('kv down'));
    await expect(cache.read(routing, PROJECT)).rejects.toThrow(ProxyTokenStateError);

    values[proxyTokenStateKey(PROJECT)] = '{"gen":2}';
    expect(await cache.read(routing, PROJECT)).toEqual({ gen: 2 });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('does not cache a malformed value', async () => {
    const cache = createProxyTokenStateCache({ now: clock().now });
    const { routing, get, values } = kvStub({ [proxyTokenStateKey(PROJECT)]: 'broken' });
    await expect(cache.read(routing, PROJECT)).rejects.toThrow(ProxyTokenStateError);
    values[proxyTokenStateKey(PROJECT)] = '{"gen":1}';
    expect(await cache.read(routing, PROJECT)).toEqual({ gen: 1 });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('clear() empties the cache', async () => {
    const cache = createProxyTokenStateCache({ now: clock().now });
    const { routing, get } = kvStub();
    await cache.read(routing, PROJECT);
    cache.clear();
    await cache.read(routing, PROJECT);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe('verifyProxyInternalAuth', () => {
  it.each(ROUTES)('accepts the value for %s', async (route) => {
    expect(await verifyProxyInternalAuth(SECRET, route, PROJECT, INTERNAL[route])).toBe(true);
  });

  it('rejects a value for another route or project', async () => {
    expect(
      await verifyProxyInternalAuth(
        SECRET,
        'resolve-resource',
        PROJECT,
        INTERNAL['resolve-worker'],
      ),
    ).toBe(false);
    expect(
      await verifyProxyInternalAuth(
        SECRET,
        'resolve-worker',
        OTHER_PROJECT,
        INTERNAL['resolve-worker'],
      ),
    ).toBe(false);
  });

  it.each([
    ['42 chars', INTERNAL['resolve-worker'].slice(0, 42)],
    ['44 chars', `${INTERNAL['resolve-worker']}A`],
    ['a generation token shape', '1.x'],
    ['a tenant token', TOK_1],
    ['the legacy token', TOK_0],
    ['empty', ''],
  ])('rejects %s without throwing', async (_name, value) => {
    await expect(verifyProxyInternalAuth(SECRET, 'resolve-worker', PROJECT, value)).resolves.toBe(
      false,
    );
  });
});

describe('deriveAiUsageTag', () => {
  it('is the project id and a 22-character MAC under its own HKDF key', async () => {
    const tag = await deriveAiUsageTag(SECRET, PROJECT);
    expect(tag).toBe(nodeAiUsageTag(PROJECT));
    expect(tag).toMatch(/^proj_000000000001\.[A-Za-z0-9_-]{22}$/);
    expect(await deriveAiUsageTag(SECRET, PROJECT)).toBe(tag);
  });

  it('differs per project and per secret', async () => {
    const tag = await deriveAiUsageTag(SECRET, PROJECT);
    expect(await deriveAiUsageTag(SECRET, OTHER_PROJECT)).not.toBe(tag);
    const otherSecret = await deriveAiUsageTag('other-secret', PROJECT);
    expect(otherSecret).not.toBe(tag);
    expect(otherSecret).toBe(nodeAiUsageTag(PROJECT, 'other-secret'));
  });

  it('shares no MAC with tenant tokens or proxy internal values', async () => {
    const mac = (await deriveAiUsageTag(SECRET, PROJECT)).slice(`${PROJECT}.`.length);
    for (const value of [TOK_0, TOK_1.slice('1.'.length), TOK_2.slice('2.'.length)]) {
      expect(value.startsWith(mac)).toBe(false);
    }
    for (const route of ROUTES) {
      expect((await deriveProxyInternalAuth(SECRET, route, PROJECT)).startsWith(mac)).toBe(false);
    }
  });

  it('accepts ids that are not project ids', async () => {
    await expect(deriveAiUsageTag(SECRET, 'project-1')).resolves.toBe(nodeAiUsageTag('project-1'));
  });
});

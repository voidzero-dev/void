import { isProjectId } from './id.ts';

/**
 * Tenant proxy tokens.
 *
 * A tenant Worker authenticates to the platform with `__VOID_PROXY_TOKEN`.
 * Two forms exist:
 *
 * - legacy (generation 0): base64url(HMAC-SHA256(JWT_SECRET, projectId)),
 *   43 characters, the bytes `hmacSignState` produces;
 * - `<gen>.<mac>` (generation 1 and above): the MAC is HMAC-SHA256 under a
 *   key derived from JWT_SECRET with HKDF, over the project id and the
 *   generation. The dot keeps it apart from the 43-character legacy token.
 *
 * ROUTING `proxy-token:<projectId>` holds the accept floor `{"gen": F}`. A
 * token is accepted when its MAC is valid and its generation is at least F.
 * A missing key is floor 0, which accepts the legacy token.
 *
 * Every check runs `isProjectId` and the syntax check before any crypto, and
 * the MAC before any KV read, so a forged token never costs a KV read.
 */

export const PROXY_TOKEN_STATE_KEY_PREFIX = 'proxy-token:';

export function proxyTokenStateKey(projectId: string): string {
  return `${PROXY_TOKEN_STATE_KEY_PREFIX}${projectId}`;
}

/** Accept floor. Generation 0 accepts the legacy token. */
export type ProxyTokenState = Readonly<{ gen: number }>;

export const LEGACY_PROXY_TOKEN_STATE: ProxyTokenState = Object.freeze({ gen: 0 });

/** KV `cacheTtl` for floor reads on request paths (the KV minimum). */
export const PROXY_TOKEN_KV_CACHE_TTL_SECONDS = 30;
/** How long a proxy isolate serves a floor it has read. */
export const PROXY_TOKEN_ISOLATE_TTL_MS = 15_000;

/** The floor could not be read or is malformed. Callers fail closed. */
export class ProxyTokenStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProxyTokenStateError';
  }
}

function isStateGeneration(gen: unknown): gen is number {
  return (
    typeof gen === 'number' &&
    Number.isSafeInteger(gen) &&
    gen >= 0 &&
    gen < Number.MAX_SAFE_INTEGER
  );
}

/** Missing state is floor 0. Anything other than `{"gen": <safe integer >= 0>}` throws. */
export function parseProxyTokenState(raw: string | null | undefined): ProxyTokenState {
  if (raw === null || raw === undefined) {
    return LEGACY_PROXY_TOKEN_STATE;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ProxyTokenStateError('proxy token state is not JSON', { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProxyTokenStateError('proxy token state is not an object');
  }
  const gen = (value as { gen?: unknown }).gen;
  if (!isStateGeneration(gen)) {
    throw new ProxyTokenStateError('proxy token state has an invalid generation');
  }
  return { gen };
}

export function serializeProxyTokenState(state: ProxyTokenState): string {
  if (!isStateGeneration(state.gen)) {
    throw new ProxyTokenStateError('proxy token state has an invalid generation');
  }
  return JSON.stringify({ gen: state.gen });
}

/**
 * The floor a deleted project keeps. Issued generations are a Postgres
 * `integer`, far below it, so no token is accepted. Deleting the key instead
 * would bring back floor 0 and the legacy token.
 */
export const CLOSED_PROXY_TOKEN_STATE = serializeProxyTokenState({
  gen: Number.MAX_SAFE_INTEGER - 1,
});

export function isAcceptedGeneration(state: ProxyTokenState, gen: number): boolean {
  return gen >= state.gen;
}

// --- Keys ---

const encoder = new TextEncoder();

const legacyKeys = new Map<string, Promise<CryptoKey>>();
const proxyTokenKeys = new Map<string, Promise<CryptoKey>>();
const proxyInternalKeys = new Map<string, Promise<CryptoKey>>();
const aiUsageKeys = new Map<string, Promise<CryptoKey>>();

function cachedKey(
  cache: Map<string, Promise<CryptoKey>>,
  secret: string,
  create: () => Promise<CryptoKey>,
): Promise<CryptoKey> {
  let key = cache.get(secret);
  if (!key) {
    key = create();
    cache.set(secret, key);
    key.catch(() => cache.delete(secret));
  }
  return key;
}

function legacyKey(secret: string): Promise<CryptoKey> {
  return cachedKey(legacyKeys, secret, () =>
    crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ),
  );
}

async function hkdfHmacKey(secret: string, salt: string, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(salt), info: encoder.encode(info) },
    base,
    // Without `length`, WebCrypto derives a 64-byte (block size) HMAC key.
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

// JWT_SECRET signs login JWTs, OAuth/link state and the legacy token as a raw
// HMAC key. The keys below are HKDF outputs with their own salt and info,
// so they differ from that raw key and from each other: a tenant token never
// verifies as a proxy internal value, and neither verifies as any raw-key MAC.
function proxyTokenKey(secret: string): Promise<CryptoKey> {
  return cachedKey(proxyTokenKeys, secret, () =>
    hkdfHmacKey(secret, 'void-proxy-token', 'proxy-token'),
  );
}

function proxyInternalKey(secret: string): Promise<CryptoKey> {
  return cachedKey(proxyInternalKeys, secret, () =>
    hkdfHmacKey(secret, 'void-proxy-internal', 'proxy-internal'),
  );
}

function aiUsageKey(secret: string): Promise<CryptoKey> {
  return cachedKey(aiUsageKeys, secret, () => hkdfHmacKey(secret, 'void-ai-usage', 'ai-usage'));
}

// --- Encoding ---

const MAC = /^[A-Za-z0-9_-]{43}$/;
const GENERATION_TOKEN = /^([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/;

function encodeBase64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Only for values that already matched `MAC`. */
function decodeMac(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}=`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sign(key: Promise<CryptoKey>, message: string): Promise<string> {
  return encodeBase64url(await crypto.subtle.sign('HMAC', await key, encoder.encode(message)));
}

async function verify(key: Promise<CryptoKey>, message: string, mac: string): Promise<boolean> {
  return crypto.subtle.verify('HMAC', await key, decodeMac(mac), encoder.encode(message));
}

function proxyTokenMessage(projectId: string, gen: number): string {
  return `void-proxy-token:${projectId}:${gen}`;
}

// --- Tenant tokens ---

/** Generation 0 is the legacy token. */
export async function deriveProxyToken(
  jwtSecret: string,
  projectId: string,
  gen: number,
): Promise<string> {
  if (!isProjectId(projectId)) {
    throw new Error('invalid project id');
  }
  if (!Number.isSafeInteger(gen) || gen < 0) {
    throw new RangeError(`invalid proxy token generation: ${gen}`);
  }
  if (gen === 0) {
    return sign(legacyKey(jwtSecret), projectId);
  }
  return `${gen}.${await sign(proxyTokenKey(jwtSecret), proxyTokenMessage(projectId, gen))}`;
}

/** The token's generation when its MAC is valid for `projectId`, else null. No I/O. */
export async function proxyTokenGeneration(
  jwtSecret: string,
  projectId: string,
  token: string,
): Promise<number | null> {
  if (!isProjectId(projectId)) {
    return null;
  }
  if (MAC.test(token)) {
    return (await verify(legacyKey(jwtSecret), projectId, token)) ? 0 : null;
  }
  const match = GENERATION_TOKEN.exec(token);
  if (!match) {
    return null;
  }
  const gen = Number(match[1]);
  if (!Number.isSafeInteger(gen)) {
    return null;
  }
  const valid = await verify(proxyTokenKey(jwtSecret), proxyTokenMessage(projectId, gen), match[2]);
  return valid ? gen : null;
}

/**
 * Reads the accept floor. A KV error or a malformed value throws
 * `ProxyTokenStateError`.
 */
export async function readProxyTokenState(
  routing: Pick<KVNamespace, 'get'>,
  projectId: string,
  options?: Readonly<{ cacheTtl?: number }>,
): Promise<ProxyTokenState> {
  let raw: string | null;
  try {
    raw =
      options?.cacheTtl === undefined
        ? await routing.get(proxyTokenStateKey(projectId))
        : await routing.get(proxyTokenStateKey(projectId), { cacheTtl: options.cacheTtl });
  } catch (error) {
    throw new ProxyTokenStateError('proxy token state unavailable', { cause: error });
  }
  return parseProxyTokenState(raw);
}

/**
 * MAC first, then the floor. `readState` runs only for a token with a valid
 * MAC; a `ProxyTokenStateError` from it propagates.
 */
export async function verifyProxyToken(
  input: Readonly<{
    jwtSecret: string;
    projectId: string;
    token: string;
    readState: () => Promise<ProxyTokenState>;
  }>,
): Promise<boolean> {
  const gen = await proxyTokenGeneration(input.jwtSecret, input.projectId, input.token);
  if (gen === null) {
    return false;
  }
  const state = await input.readState();
  if (!isAcceptedGeneration(state, gen)) {
    console.warn('[proxy-token] rejected generation', {
      projectId: input.projectId,
      gen,
      floor: state.gen,
    });
    return false;
  }
  return true;
}

// --- Isolate cache ---

export type ProxyTokenStateCache = Readonly<{
  read(routing: Pick<KVNamespace, 'get'>, projectId: string): Promise<ProxyTokenState>;
  clear(): void;
}>;

/**
 * Floors read with `cacheTtl`, kept for `ttlMs` (missing keys too). Errors are
 * never cached, and an expired entry is never served when KV fails.
 */
export function createProxyTokenStateCache(
  options?: Readonly<{ maxEntries?: number; ttlMs?: number; now?: () => number }>,
): ProxyTokenStateCache {
  const maxEntries = options?.maxEntries ?? 1000;
  const ttlMs = options?.ttlMs ?? PROXY_TOKEN_ISOLATE_TTL_MS;
  const now = options?.now ?? Date.now;
  const entries = new Map<string, { state: ProxyTokenState; fetchedAt: number }>();

  return {
    async read(routing, projectId) {
      const entry = entries.get(projectId);
      if (entry && now() - entry.fetchedAt < ttlMs) {
        return entry.state;
      }
      entries.delete(projectId);
      const state = await readProxyTokenState(routing, projectId, {
        cacheTtl: PROXY_TOKEN_KV_CACHE_TTL_SECONDS,
      });
      entries.set(projectId, { state, fetchedAt: now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
      return state;
    },
    clear() {
      entries.clear();
    },
  };
}

// --- Proxy-to-API metadata auth ---

/** Header the proxy uses to authenticate itself to the API metadata routes. */
export const PROXY_INTERNAL_AUTH_HEADER = 'x-void-proxy-internal';

export type ProxyInternalRoute =
  | 'resolve-worker'
  | 'resolve-resource'
  | 'verify-prerender-build'
  | 'ai-logging';

function proxyInternalMessage(route: ProxyInternalRoute, projectId: string): string {
  return `void-proxy-internal\n${route}\n${projectId}`;
}

/**
 * Proxy credential for one metadata route and project. Platform only: never
 * put it in a Worker binding, KV, a response body or a log.
 */
export function deriveProxyInternalAuth(
  jwtSecret: string,
  route: ProxyInternalRoute,
  projectId: string,
): Promise<string> {
  return sign(proxyInternalKey(jwtSecret), proxyInternalMessage(route, projectId));
}

/** Never throws on bad input. */
export async function verifyProxyInternalAuth(
  jwtSecret: string,
  route: ProxyInternalRoute,
  projectId: string,
  value: string,
): Promise<boolean> {
  if (!MAC.test(value)) {
    return false;
  }
  return verify(proxyInternalKey(jwtSecret), proxyInternalMessage(route, projectId), value);
}

// --- AI usage tag ---

/**
 * The project value the proxy writes into AI Gateway metadata and the usage
 * query filters on: `<projectId>.<22 base64url MAC characters>`. Only the
 * platform can compute it, so gateway rows written by anyone else never count
 * toward a project's AI usage.
 *
 * Platform only: never put it in a Worker binding or a response. Rotating
 * JWT_SECRET changes every tag, so counted AI usage restarts for the current
 * billing period. The project id is not validated here.
 */
export async function deriveAiUsageTag(jwtSecret: string, projectId: string): Promise<string> {
  const mac = await sign(aiUsageKey(jwtSecret), `void-ai-usage\n${projectId}`);
  return `${projectId}.${mac.slice(0, 22)}`;
}

import { extname } from 'node:path';
import { hash as blake3hash } from 'blake3-jit';
import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import {
  computeAssetHash,
  computeAssetStreamHashes,
  createAssetUploadSession,
  deleteUnreferencedAssets,
  deleteWorkerBundle,
  normalizeForCfAssetSession,
  resolveAssetContentTypes,
  scanProjectAssetOrphanCandidates,
  uploadAssetBuckets,
  type AssetEntry,
} from '../../src/assets.ts';

const enc = new TextEncoder();

describe('asset hash compatibility', () => {
  it.each([0, 1, 2, 3, 48 * 1024 - 1, 48 * 1024, 48 * 1024 + 1, 96 * 1024 + 2])(
    'preserves the provider base64 and extension hash for %i bytes',
    (size) => {
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
      for (const path of ['/asset.js', '/nested/file.css', '/extensionless']) {
        const input = Buffer.from(bytes).toString('base64') + extname(path).substring(1);
        const expected = Buffer.from(blake3hash(enc.encode(input)))
          .subarray(0, 16)
          .toString('hex');
        expect(computeAssetHash(bytes.buffer, path)).toBe(expected);
      }
    },
  );
  it('preserves the provider hash across arbitrary streamed base64 boundaries', async () => {
    const bytes = Uint8Array.from({ length: 96 * 1024 + 2 }, (_, index) => index % 251);
    let offset = 0;
    let step = 0;
    const chunks = [1, 2, 0, 5, 48 * 1024 + 1, 7];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, offset + chunks[step++ % chunks.length]!);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
    expect(
      await computeAssetStreamHashes(body, ['/a.js', '/same.js', '/file.css'], bytes.length),
    ).toEqual({
      size: bytes.length,
      hashes: [
        computeAssetHash(bytes.buffer, '/a.js'),
        computeAssetHash(bytes.buffer, '/file.css'),
      ],
    });
  });
  it('cancels a stream that exceeds the recorded size', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
      },
      cancel,
    });
    await expect(computeAssetStreamHashes(body, ['/a.js'], 2)).rejects.toThrow('recorded size');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('times out a stalled read even when cancellation never settles', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      });
      const assertion = expect(computeAssetStreamHashes(body, ['/a.js'], 10)).rejects.toThrow(
        'two-minute deadline',
      );
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('asset content-type indexing', () => {
  it('keeps the first matching path, requested order, and the unknown-type sentinel', () => {
    const manifest = {
      '/first.js': { hash: 'same', size: 1 },
      '/later.css': { hash: 'same', size: 1 },
      '/image.png': { hash: 'image', size: 2 },
    };
    expect([...resolveAssetContentTypes(manifest, ['image', 'same', 'missing'])]).toEqual([
      ['image', 'image/png'],
      ['same', 'text/javascript; charset=utf-8'],
      ['missing', 'application/null'],
    ]);
    expect(resolveAssetContentTypes(manifest, [])).toEqual(new Map());
  });
});
function entry(content: string | Uint8Array, contentType: string): AssetEntry {
  return {
    bytes: typeof content === 'string' ? enc.encode(content) : content,
    contentType,
  };
}

function createMockKV() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    get: vi.fn(async (key: string, _opts?: unknown) => store.get(key) ?? null),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
    })),
    put: vi.fn(async (key: string, value: ArrayBuffer | string, _opts?: unknown) => {
      store.set(key, typeof value === 'string' ? new TextEncoder().encode(value).buffer : value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
  } as unknown as KVNamespace & { store: Map<string, ArrayBuffer> };
}

function createMockR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    put: vi.fn(async (key: string, value: ArrayBuffer, _opts?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (keys: string | Array<string>) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
      }
    }),
    get: vi.fn(async (key: string) =>
      store.has(key)
        ? {
            body: new ReadableStream(),
            httpMetadata: {},
            size: 0,
            httpEtag: '"test"',
          }
        : null,
    ),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket & { store: Map<string, ArrayBuffer> };
}

async function readBodyText(body: unknown): Promise<string> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Array<Uint8Array> = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
  if (typeof body === 'string') {
    return body;
  }
  throw new Error('unsupported body type');
}

/** Create a JWT with the given expiration time (Unix seconds). */
function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ exp }));
  return `${header}.${payload}.fake-signature`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deleteUnreferencedAssets', () => {
  it('deletes only hashes not referenced by retained deployments', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));
    kv.store.set('assets/proj_test/hash_b', new ArrayBuffer(0));
    r2.store.set('assets/proj_test/hash_c', new ArrayBuffer(0));

    const evictedHashes = ['hash_a', 'hash_b', 'hash_c'];
    const retainedHashes = new Set(['hash_b']);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    expect(kv.store.has('assets/proj_test/hash_a')).toBe(false);
    expect(kv.store.has('assets/proj_test/hash_b')).toBe(true);
    expect(r2.store.has('assets/proj_test/hash_c')).toBe(false);
  });

  it('does nothing when all evicted hashes are retained', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));

    const evictedHashes = ['hash_a'];
    const retainedHashes = new Set(['hash_a']);

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
    expect(kv.store.has('assets/proj_test/hash_a')).toBe(true);
  });

  it('does nothing when evictedHashes is empty', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();

    await deleteUnreferencedAssets(kv, r2, [], new Set(), 'proj_test');

    expect(kv.delete).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('only deletes project-scoped keys, not legacy shared keys', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    // Legacy key exists for the same hash
    kv.store.set('assets/hash_a', new ArrayBuffer(0));
    // Scoped key also exists
    kv.store.set('assets/proj_test/hash_a', new ArrayBuffer(0));

    const evictedHashes = ['hash_a'];
    const retainedHashes = new Set<string>();

    await deleteUnreferencedAssets(kv, r2, evictedHashes, retainedHashes, 'proj_test');

    // Scoped key deleted
    expect(kv.store.has('assets/proj_test/hash_a')).toBe(false);
    // Legacy key untouched
    expect(kv.store.has('assets/hash_a')).toBe(true);
  });

  it('preserves a recently uploaded R2 object that an in-flight deploy may claim', async () => {
    const kv = createMockKV();
    const r2 = createMockR2();
    const key = 'assets/proj_test/hash_fresh';
    r2.store.set(key, new ArrayBuffer(0));
    vi.mocked(r2.head).mockResolvedValue({
      key,
      version: 'fresh-version',
      size: 0,
      etag: 'fresh-etag',
      httpEtag: '"fresh-etag"',
      uploaded: new Date(),
      checksums: {},
      writeHttpMetadata: vi.fn(),
    } as unknown as R2Object);

    await deleteUnreferencedAssets(kv, r2, ['hash_fresh'], new Set(), 'proj_test');

    expect(r2.store.has(key)).toBe(true);
    expect(r2.delete).not.toHaveBeenCalled();
  });
});

function createAssetScanR2Mock(
  objects: ReadonlyArray<{ key: string; uploaded: Date }>,
  pageSize = 1000,
) {
  return {
    list: vi.fn(async (options?: { prefix?: string; cursor?: string; limit?: number }) => {
      const prefix = options?.prefix ?? '';
      const matching = objects.filter((object) => object.key.startsWith(prefix));
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = Math.min(options?.limit ?? pageSize, pageSize);
      const page = matching.slice(start, start + limit);
      const next = start + page.length;
      const truncated = next < matching.length;
      return {
        objects: page,
        delimitedPrefixes: [],
        truncated,
        ...(truncated ? { cursor: String(next) } : {}),
      } as unknown as R2Objects;
    }),
    delete: vi.fn(),
  } as unknown as R2Bucket & { delete: ReturnType<typeof vi.fn> };
}

describe('scanProjectAssetOrphanCandidates', () => {
  it('emits old and malformed keys while preserving fresh uploads and project scope', async () => {
    const now = Date.now();
    const r2 = createAssetScanR2Mock([
      { key: 'assets/proj_test/hash_old', uploaded: new Date(now - 3_600_001) },
      { key: 'assets/proj_test/hash_fresh', uploaded: new Date(now - 3_599_000) },
      // Self-healing: a prefix-only key is
      // malformed and remains a candidate even when it was uploaded recently.
      { key: 'assets/proj_test/', uploaded: new Date(now) },
      { key: 'assets/proj_other/hash_old', uploaded: new Date(now - 3_600_001) },
    ]);
    const batches: Array<ReadonlyArray<string>> = [];

    const count = await scanProjectAssetOrphanCandidates(r2, 'proj_test', async (batch) => {
      batches.push(batch);
    });

    expect(count).toBe(2);
    expect(batches).toEqual([['hash_old', '']]);
    expect(r2.list).toHaveBeenCalledWith({
      prefix: 'assets/proj_test/',
      cursor: undefined,
      limit: 1000,
    });
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('paginates and invokes the callback in batches of at most 1000 candidates', async () => {
    const uploaded = new Date(Date.now() - 3_600_001);
    const r2 = createAssetScanR2Mock(
      Array.from({ length: 1505 }, (_, index) => ({
        key: `assets/proj_test/hash_${index}`,
        uploaded,
      })),
      1505,
    );
    const batches: Array<ReadonlyArray<string>> = [];

    const count = await scanProjectAssetOrphanCandidates(r2, 'proj_test', async (batch) => {
      batches.push(batch);
    });

    expect(count).toBe(1505);
    expect(vi.mocked(r2.list).mock.calls.length).toBeGreaterThan(1);
    expect(batches.map((batch) => batch.length)).toEqual([1000, 505]);
    expect(batches.flat()).toHaveLength(1505);
    expect(batches.every((batch) => batch.length > 0 && batch.length <= 1000)).toBe(true);
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('does not invoke the callback when every matching object is fresh', async () => {
    const r2 = createAssetScanR2Mock([
      { key: 'assets/proj_test/hash_fresh', uploaded: new Date() },
    ]);
    const onBatch = vi.fn(async (_batch: ReadonlyArray<string>) => {});

    const count = await scanProjectAssetOrphanCandidates(r2, 'proj_test', onBatch);

    expect(count).toBe(0);
    expect(onBatch).not.toHaveBeenCalled();
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('stops at the requested per-invocation candidate budget', async () => {
    const uploaded = new Date(Date.now() - 3_600_001);
    const r2 = createAssetScanR2Mock(
      Array.from({ length: 1500 }, (_, index) => ({
        key: `assets/proj_test/hash_${index}`,
        uploaded,
      })),
      500,
    );
    const batches: Array<ReadonlyArray<string>> = [];

    const count = await scanProjectAssetOrphanCandidates(
      r2,
      'proj_test',
      async (batch) => {
        batches.push(batch);
      },
      { maxCandidates: 200 },
    );

    expect(count).toBe(200);
    expect(batches.map((batch) => batch.length)).toEqual([200]);
    expect(r2.list).toHaveBeenCalledTimes(1);
    expect(r2.delete).not.toHaveBeenCalled();
  });
});

describe('uploadAssetBuckets', () => {
  const singleAssetMap = new Map<string, AssetEntry>([['hash1', entry('hello', 'text/plain')]]);
  const opts = { retryDelayMs: 0, gatewayDelayMs: 0 };

  it('returns session JWT directly when buckets are empty (all cached)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets('acct', 'session-jwt', [], singleAssetMap, opts);

    expect(completionJwt).toBe('session-jwt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns session JWT directly when buckets contain only empty arrays', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [[]],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('session-jwt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the returned jwt when Cloudflare responds with JSON', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { jwt: 'completion-jwt' } }));
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams base64 multipart asset bodies with correct headers and encoded content', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer session-jwt',
      });
      expect(init?.headers).toMatchObject({
        'Content-Type': expect.stringContaining('multipart/form-data; boundary='),
      });
      const body = await readBodyText(init?.body);
      expect(body).toContain('Content-Disposition: form-data; name="hash1"; filename="hash1"');
      expect(body).toContain('Content-Type: text/plain');
      expect(body).toContain('aGVsbG8=');
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
  });

  it('retries on 5xx errors and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response('Bad Gateway', { status: 502 });
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('accepts missing JWT for non-final buckets', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // First bucket (non-final): 202 with no JWT
      if (calls === 1) {
        return Response.json({ result: {} }, { status: 202 });
      }
      // Second bucket (final): 200 with completion JWT
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1'], ['hash2']],
      new Map<string, AssetEntry>([
        ['hash1', entry('a', 'text/plain')],
        ['hash2', entry('b', 'text/plain')],
      ]),
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses session JWT for auth on all buckets (no chaining)', async () => {
    const fetchMock = vi.fn(async () => {
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1'], ['hash2']],
      new Map<string, AssetEntry>([
        ['hash1', entry('a', 'text/plain')],
        ['hash2', entry('b', 'text/plain')],
      ]),
      opts,
    );

    // Both calls should use session JWT, not the response JWT from bucket 1
    for (const call of fetchMock.mock.calls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (call as any)[1] as { headers: { Authorization: string } };
      expect(options.headers.Authorization).toBe('Bearer session-jwt');
    }
  });

  it('retries malformed 2xx (CF edge bug) and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 1) {
        return new Response('Assets have already been uploaded.');
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when no bucket returns a completion JWT', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: {} }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('no completion JWT received');

    // Valid response — no retries burned, just 1 call
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 4xx errors before throwing (matches Wrangler)', async () => {
    const fetchMock = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (401)');

    // 4xx errors are retried just like 5xx (matching Wrangler's behavior)
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('524 gateway errors get free retries before counting as attempts', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // Return 524 for the first 6 calls, then succeed
      if (calls <= 6) {
        return new Response('A timeout occurred', { status: 524 });
      }
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const completionJwt = await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['hash1']],
      singleAssetMap,
      opts,
    );

    expect(completionJwt).toBe('completion-jwt');
    // 6 failures + 1 success = 7 calls. The first 4 gateway errors are free
    // (gwErr 1-4, attempts stays 0). The 5th (gwErr=5 >= MAX=5) increments
    // attempts to 1, the 6th increments to 2. Call 7 succeeds.
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('throws after exhausting gateway + regular retries', async () => {
    // Always return 524 — eventually should exhaust all retries
    const fetchMock = vi.fn(async () => new Response('A timeout occurred', { status: 524 }));
    vi.stubGlobal('fetch', fetchMock);

    // Rethrows the original AssetUploadError (matching Wrangler's `throw e;`)
    await expect(
      uploadAssetBuckets('acct', 'session-jwt', [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (524)');

    // 4 free gateway errors (gwErr 1-4, attempts stays 0)
    // + 6 counted (gwErr 5-10, each increments attempts 1→2→3→4→5→check fails)
    // = 10 total calls
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('uploads buckets concurrently', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const fetchMock = vi.fn(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Yield to let other concurrent tasks start
      await new Promise((r) => setTimeout(r, 1));
      currentConcurrent--;
      return Response.json({ result: { jwt: 'completion-jwt' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAssetBuckets(
      'acct',
      'session-jwt',
      [['h1'], ['h2'], ['h3']],
      new Map<string, AssetEntry>([
        ['h1', entry('a', 'text/plain')],
        ['h2', entry('b', 'text/plain')],
        ['h3', entry('c', 'text/plain')],
      ]),
      opts,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // All 3 should run concurrently since UPLOAD_CONCURRENCY=3
    expect(maxConcurrent).toBe(3);
  });

  it('JWT expiration gives specific error message when retries exhausted', async () => {
    // JWT that expired 1 hour ago
    const expiredJwt = makeJwt(Math.floor(Date.now() / 1000) - 3600);
    const fetchMock = vi.fn(async () => new Response('Server Error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadAssetBuckets('acct', expiredJwt, [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow(/upload session has expired/);
  });

  it('rethrows original error when retries exhausted and JWT valid', async () => {
    // JWT that expires in 1 hour
    const validJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const fetchMock = vi.fn(async () => new Response('Server Error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    // Original AssetUploadError is rethrown (matching Wrangler's `throw e;`)
    await expect(
      uploadAssetBuckets('acct', validJwt, [['hash1']], singleAssetMap, opts),
    ).rejects.toThrow('asset upload failed (500)');
  });
});

describe('createAssetUploadSession', () => {
  const manifest = { '/index.html': { hash: 'abc123', size: 100 } };

  it('returns jwt and buckets on success', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ result: { jwt: 'session-jwt', buckets: [['abc123']] } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'session-jwt', buckets: [['abc123']] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on plain-text response and succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return new Response('Assets have already been uploaded.');
      }
      return Response.json({ result: { jwt: 'retry-jwt', buckets: [] } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'retry-jwt', buckets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on plain-text responses', async () => {
    const fetchMock = vi.fn(async () => new Response('Assets have already been uploaded.'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('asset upload session returned invalid response');

    // 1 initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries a 5xx response and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ result: { jwt: 'retry-jwt', buckets: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'retry-jwt', buckets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network error and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ result: { jwt: 'retry-jwt', buckets: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'retry-jwt', buckets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The headers arrive, then the connection drops while the body is read.
  const droppedResponse = (status = 200) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      }),
      { status },
    );

  it('retries when the response body drops and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(droppedResponse())
      .mockResolvedValueOnce(Response.json({ result: { jwt: 'retry-jwt', buckets: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, {
      retryDelayMs: 0,
    });

    expect(result).toEqual({ jwt: 'retry-jwt', buckets: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws the network error after exhausting retries', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('fetch failed');

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('throws the last 5xx response after exhausting retries', async () => {
    const fetchMock = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('asset upload session failed: Bad Gateway');

    // 1 initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([401, 429])('does not retry a 4xx response (%i)', async (status) => {
    const fetchMock = vi.fn(async () => new Response('Denied', { status }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow('asset upload session failed: Denied');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429])('does not retry a 4xx response whose body drops (%i)', async (status) => {
    const fetchMock = vi.fn(async () => droppedResponse(status));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createAssetUploadSession('acct', 'token', 'ns', 'worker', manifest, { retryDelayMs: 0 }),
    ).rejects.toThrow(`asset upload session failed (HTTP ${status})`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeForCfAssetSession', () => {
  it('strips v2 manifest extras (blake3, md5) and keeps only {hash, size}', () => {
    const v2Manifest = {
      '/index.html': {
        // v2 wire shape from the framework CLI
        blake3: 'a'.repeat(32),
        md5: 'b'.repeat(32),
        size: 100,
        hash: 'a'.repeat(32),
      } as unknown as { hash: string; size: number },
      '/style.css': {
        blake3: 'c'.repeat(32),
        md5: 'd'.repeat(32),
        size: 50,
        hash: 'c'.repeat(32),
      } as unknown as { hash: string; size: number },
    };

    const out = normalizeForCfAssetSession(v2Manifest);

    expect(Object.keys(out).sort()).toEqual(['/index.html', '/style.css']);
    for (const entry of Object.values(out)) {
      expect(Object.keys(entry).sort()).toEqual(['hash', 'size']);
      expect(entry).not.toHaveProperty('blake3');
      expect(entry).not.toHaveProperty('md5');
    }
    expect(out['/index.html']).toEqual({ hash: 'a'.repeat(32), size: 100 });
    expect(out['/style.css']).toEqual({ hash: 'c'.repeat(32), size: 50 });
  });

  it('returns a fresh object — mutating input does not affect output', () => {
    const input = { '/a.js': { hash: 'h', size: 1 } };
    const out = normalizeForCfAssetSession(input);
    expect(out).not.toBe(input);
    expect(out['/a.js']).not.toBe(input['/a.js']);
    // mutating input post-normalize must not leak through
    (input['/a.js'] as { extra?: string }).extra = 'leaked';
    expect(out['/a.js']).not.toHaveProperty('extra');
  });

  it('passes a manifest that is already {hash, size} through unchanged in shape', () => {
    const input = { '/index.html': { hash: 'aaa', size: 7 } };
    const out = normalizeForCfAssetSession(input);
    expect(out).toEqual(input);
  });

  it('preserves all paths, including empty manifests', () => {
    expect(normalizeForCfAssetSession({})).toEqual({});
  });
});

function createBundleR2Mock(opts?: { listPageSize?: number }) {
  const store = new Set<string>();
  const listPageSize = opts?.listPageSize ?? 1000;
  return {
    store,
    list: vi.fn(async (options?: { prefix?: string; cursor?: string }) => {
      const prefix = options?.prefix ?? '';
      const allKeys = [...store].filter((k) => k.startsWith(prefix)).sort();
      const startIndex = options?.cursor ? Number(options.cursor) : 0;
      const slice = allKeys.slice(startIndex, startIndex + listPageSize);
      const nextIndex = startIndex + slice.length;
      const truncated = nextIndex < allKeys.length;
      const objects = slice.map((k) => ({ key: k })) as Array<R2Object>;
      if (truncated) {
        return {
          objects,
          delimitedPrefixes: [],
          truncated: true as const,
          cursor: String(nextIndex),
        };
      }
      return {
        objects,
        delimitedPrefixes: [],
        truncated: false as const,
      };
    }),
    delete: vi.fn(async (keys: string | Array<string>) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
      }
    }),
  } as unknown as R2Bucket & { store: Set<string> };
}

describe('deleteWorkerBundle', () => {
  it('deletes all keys under the deploy prefix', async () => {
    const r2 = createBundleR2Mock();
    r2.store.add('worker-bundles/p_1/d_2/index.js');
    r2.store.add('worker-bundles/p_1/d_2/chunks/a.js');
    r2.store.add('worker-bundles/p_1/d_3/index.js');
    expect(r2.store.size).toBe(3);

    await deleteWorkerBundle(r2, 'p_1', 'd_2');

    expect(r2.store.has('worker-bundles/p_1/d_2/index.js')).toBe(false);
    expect(r2.store.has('worker-bundles/p_1/d_2/chunks/a.js')).toBe(false);
    expect(r2.store.has('worker-bundles/p_1/d_3/index.js')).toBe(true);
  });

  it('is idempotent when there is nothing to delete', async () => {
    const r2 = createBundleR2Mock();
    await expect(deleteWorkerBundle(r2, 'p_1', 'd_2')).resolves.toBeUndefined();
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('paginates through multiple R2 list pages and batch-deletes in chunks of 1000', async () => {
    const r2 = createBundleR2Mock({ listPageSize: 250 });
    for (let index = 0; index < 1500; index++) {
      r2.store.add(`worker-bundles/p_1/d_big/mod${index}.js`);
    }
    expect(r2.store.size).toBe(1500);

    await deleteWorkerBundle(r2, 'p_1', 'd_big');

    expect(r2.store.size).toBe(0);
    const deleteCalls = vi.mocked(r2.delete).mock.calls;
    // 1500 keys → at most 1000 + 500 in two batches; never a batch larger than 1000.
    for (const [arg] of deleteCalls) {
      const arr = Array.isArray(arg) ? arg : [arg];
      expect(arr.length).toBeLessThanOrEqual(1000);
    }
    const totalDeleted = deleteCalls.reduce((sum, [arg]) => {
      const arr = Array.isArray(arg) ? arg : [arg];
      return sum + arr.length;
    }, 0);
    expect(totalDeleted).toBe(1500);
  });
});

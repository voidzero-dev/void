import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { Buffer } from '../../../src/cli/node-buffer.ts';
import { createBindingHandler } from '../../../src/runtime/remote/binding-handler.ts';
import { ProxyClient } from '../../../src/runtime/remote/client.ts';
import { ProxyR2Bucket } from '../../../src/runtime/remote/r2.ts';

function createClient() {
  return new ProxyClient('https://proxy.void.cloud', 'jwt-token', 'proj_1');
}

/** Send ProxyClient requests to the binding handler that a deployed worker runs. */
function connectBucket(bucket: Partial<Record<keyof R2Bucket, unknown>>) {
  const handler = createBindingHandler({ __VOID_PROXY_TOKEN: 'internal', STORAGE: bucket });
  globalThis.fetch = vi.fn(async (input, init) =>
    handler.request(new URL(String(input)).pathname, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-void-internal': 'internal' },
    }),
  ) as typeof fetch;
  return new ProxyR2Bucket(createClient(), 'STORAGE');
}

const uploaded = new Date('2024-01-01T00:00:00Z');
const cacheExpiry = new Date('2030-01-01T00:00:00Z');
const stored = {
  key: 'a.txt',
  size: 10,
  etag: 'abc',
  httpEtag: '"abc"',
  version: 'v1',
  uploaded,
  httpMetadata: { contentType: 'text/plain', cacheControl: 'max-age=60', cacheExpiry },
  customMetadata: { owner: 'x' },
};

function mockFetch(response: unknown, contentType = 'application/json') {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        headers: { 'content-type': contentType },
      }),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
}

describe('ProxyR2Bucket', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('head()', () => {
    it('returns R2Object with metadata', async () => {
      mockFetch({
        key: 'file.txt',
        size: 1024,
        etag: 'abc123',
        lastModified: '2024-01-01T00:00:00Z',
        contentType: 'text/plain',
      });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.head('file.txt');

      expect(obj).not.toBeNull();
      expect(obj!.key).toBe('file.txt');
      expect(obj!.size).toBe(1024);
      expect(obj!.etag).toBe('abc123');
    });

    it('returns null for missing key', async () => {
      mockFetch(null);

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.head('missing.txt');

      expect(obj).toBeNull();
    });

    it('returns the stored object metadata through the binding handler', async () => {
      const obj = await connectBucket({ head: async () => stored }).head('a.txt');

      expect(obj).toMatchObject({
        etag: 'abc',
        httpEtag: '"abc"',
        version: 'v1',
        uploaded,
        httpMetadata: { cacheControl: 'max-age=60', cacheExpiry },
        customMetadata: { owner: 'x' },
      });
    });

    it('removes the quotes from an etag in the HTTP form', async () => {
      mockFetch({
        key: 'file.txt',
        size: 1,
        etag: '"abc"',
        lastModified: '2024-01-01T00:00:00Z',
        contentType: 'text/plain',
      });

      const obj = await new ProxyR2Bucket(createClient(), 'STORAGE').head('file.txt');

      expect(obj!.etag).toBe('abc');
      expect(obj!.httpEtag).toBe('"abc"');
    });
  });

  describe('get()', () => {
    it('returns R2ObjectBody with stream for existing object', async () => {
      const body = 'file contents here';
      const fetchMock = vi.fn(
        async () =>
          new Response(body, {
            headers: {
              'content-type': 'text/plain',
              'content-length': String(body.length),
              etag: 'abc123',
            },
          }),
      );
      globalThis.fetch = fetchMock;

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.get('file.txt');

      expect(obj).not.toBeNull();
      expect(obj!.key).toBe('file.txt');
      expect(obj!.size).toBe(body.length);
      const text = await obj!.text();
      expect(text).toBe('file contents here');
      expect(fetchMock).toHaveBeenCalledWith('https://proxy.void.cloud/r2/get', expect.anything());
    });

    it('returns null for missing key', async () => {
      mockFetch(null);

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const obj = await r2.get('missing.txt');

      expect(obj).toBeNull();
    });

    it('returns object metadata and writes HTTP metadata through the binding handler', async () => {
      const body = '0123456789';
      const r2 = connectBucket({
        get: async () => ({
          ...stored,
          customMetadata: { owner: '日本' },
          body: new Response(body).body,
        }),
      });

      const obj = await r2.get('a.txt');
      const headers = new Headers();
      obj!.writeHttpMetadata(headers);

      expect(obj).toMatchObject({
        etag: 'abc',
        httpEtag: '"abc"',
        version: 'v1',
        uploaded,
        customMetadata: { owner: '日本' },
      });
      expect(Object.fromEntries(headers)).toEqual({
        'content-type': 'text/plain',
        'cache-control': 'max-age=60',
        expires: cacheExpiry.toUTCString(),
      });
      expect(await obj!.text()).toBe(body);
    });

    it.each<[string, R2GetOptions]>([
      ['other request headers', { range: new Headers({ accept: '*/*' }), onlyIf: new Headers() }],
      ['empty options', { onlyIf: { etagMatches: undefined, secondsGranularity: true } }],
      ['a Range header', { range: new Headers({ range: 'bytes=0-1' }) }],
      ['an If-None-Match header', { onlyIf: new Headers({ 'if-none-match': '"abc"' }) }],
    ])('returns the whole object for %s', async (_name, options) => {
      const get = vi.fn(async () => ({ ...stored, body: new Response('hello').body }));

      const obj = await connectBucket({ get }).get('a.txt', options);

      expect(await obj!.text()).toBe('hello');
      expect(get).toHaveBeenCalledWith('a.txt');
    });

    it.each<[string, R2GetOptions]>([
      ['range', { range: { offset: 2, length: 3 } }],
      ['onlyIf', { onlyIf: { etagMatches: 'abc' } }],
    ])('rejects %s without a request', async (_name, options) => {
      const fetchMock = mockFetch(null);

      await expect(
        new ProxyR2Bucket(createClient(), 'STORAGE').get('a.txt', options),
      ).rejects.toThrow('remote: R2 get() with range or onlyIf is not supported in remote mode.');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('put()', () => {
    it('rejects malformed conditions before calling R2', async () => {
      const put = vi.fn();
      const handler = createBindingHandler({ __VOID_PROXY_TOKEN: 'internal', STORAGE: { put } });
      const response = await handler.request('/r2/put-conditional', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-void-internal': 'internal' },
        body: JSON.stringify({
          binding: 'STORAGE',
          key: 'key',
          value: 'new',
          onlyIf: { uploadedAfter: 'invalid' },
        }),
      });
      expect(response.status).toBe(400);
      expect(put).not.toHaveBeenCalled();
    });

    it.each(['object', 'headers'] as const)(
      'preserves %s conditions and a rejected write through the binding handler',
      async (kind) => {
        const put = vi.fn(async () => null);
        const handler = createBindingHandler({ __VOID_PROXY_TOKEN: 'internal', STORAGE: { put } });
        const requests: Array<string> = [];
        globalThis.fetch = vi.fn(async (input, init) => {
          const path = new URL(String(input)).pathname;
          requests.push(path);
          return handler.request(path, {
            ...init,
            headers: { 'content-type': 'application/json', 'x-void-internal': 'internal' },
          });
        }) as typeof fetch;
        const before = new Date('2026-01-01T00:00:00Z');
        const onlyIf =
          kind === 'headers'
            ? new Headers({ 'if-match': 'old' })
            : { etagMatches: 'old', uploadedBefore: before, secondsGranularity: true };
        const result = await new ProxyR2Bucket(createClient(), 'STORAGE').put('key', 'new', {
          onlyIf,
        });
        expect(requests).toEqual(['/r2/put-conditional']);
        expect(result).toBeNull();
        const options = (put.mock.calls[0] as unknown as [string, unknown, R2PutOptions])[2];
        if (kind === 'headers') {
          expect((options.onlyIf as Headers).get('if-match')).toBe('old');
        } else {
          expect(options.onlyIf).toEqual(onlyIf);
          expect((options.onlyIf as R2Conditional).uploadedBefore).toBeInstanceOf(Date);
        }
      },
    );

    it('returns actual metadata from a successful conditional put', async () => {
      mockFetch({
        key: 'file.txt',
        size: 5,
        etag: 'new-etag',
        version: 'v1',
        lastModified: '2026-01-01T00:00:00Z',
        contentType: 'text/plain',
        customMetadata: { owner: 'me' },
      });
      const result = await new ProxyR2Bucket(createClient(), 'STORAGE').put('file.txt', 'hello', {
        onlyIf: { etagDoesNotMatch: '*' },
      });
      expect(result).toMatchObject({
        size: 5,
        etag: 'new-etag',
        version: 'v1',
        customMetadata: { owner: 'me' },
      });
    });

    it.each([
      ['typed array slice', () => new Uint8Array([9, 1, 2, 8]).subarray(1, 3), [1, 2]],
      ['DataView', () => new DataView(new Uint8Array([9, 1, 2, 8]).buffer, 1, 2), [1, 2]],
      ['pooled Buffer', () => Buffer.from([9, 1, 2, 8]).subarray(1, 3), [1, 2]],
      ['empty view', () => new Uint8Array([9, 8]).subarray(1, 1), []],
    ] as const)('uploads only the bytes in a %s', async (_name, makeValue, expected) => {
      mockFetch({ success: true });
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('binary.bin', makeValue());

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(typeof body.base64).toBe('string');
      expect(Array.from(Buffer.from(body.base64, 'base64'))).toEqual(expected);
    });

    it('sends string value as text', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const result = await r2.put('file.txt', 'hello world');

      expect(result).not.toBeNull();
      expect(result!.key).toBe('file.txt');

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.key).toBe('file.txt');
      expect(body.value).toBe('hello world');
      expect(body.binding).toBe('STORAGE');
      expect(call[0]).toBe('https://proxy.void.cloud/r2/put');
    });

    it('sends ArrayBuffer value as base64', async () => {
      mockFetch({ success: true });

      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('binary.bin', data.buffer);

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.base64).toBe(btoa('Hello'));
    });

    it('stores all HTTP metadata through the binding handler', async () => {
      const put = vi.fn(async () => stored);
      const r2 = connectBucket({ put });

      await r2.put('a.txt', 'x', {
        httpMetadata: { contentType: 'text/plain', cacheControl: 'max-age=60', cacheExpiry },
      });
      await r2.put('b.txt', 'x', {
        httpMetadata: new Headers({ 'content-type': 'text/css', 'cache-control': 'no-cache' }),
      });

      const options = put.mock.calls.map(
        (call) => (call as unknown as [string, unknown, R2PutOptions])[2].httpMetadata,
      );
      expect(options[0]).toEqual({
        contentType: 'text/plain',
        cacheControl: 'max-age=60',
        cacheExpiry,
      });
      expect(options[1]).toBeInstanceOf(Headers);
      expect(Object.fromEntries(options[1] as Headers)).toEqual({
        'content-type': 'text/css',
        'cache-control': 'no-cache',
      });
    });

    it.each<[string, unknown, R2PutOptions, string]>([
      [
        'the REST fallback',
        { success: true },
        { httpMetadata: { contentType: 'text/plain' }, customMetadata: { owner: 'x' } },
        'without customMetadata.',
      ],
      [
        'an older handler',
        { key: 'a.txt', size: 1, lastModified: '', httpMetadata: { contentType: 'text/plain' } },
        {
          httpMetadata: new Headers({ 'content-type': 'text/plain', 'cache-control': 'no-cache' }),
        },
        'without cacheControl.',
      ],
    ])('rejects metadata that %s did not store', async (_name, response, options, message) => {
      mockFetch(response);

      await expect(
        new ProxyR2Bucket(createClient(), 'STORAGE').put('a.txt', 'x', options),
      ).rejects.toThrow(`remote: R2 put() stored "a.txt" ${message} Remote R2 metadata needs`);
    });

    it('sends httpMetadata.contentType', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.put('file.json', '{"a":1}', {
        httpMetadata: { contentType: 'application/json' },
      });

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.contentType).toBe('application/json');
    });
  });

  describe('delete()', () => {
    it('deletes single key', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.delete('file.txt');

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.key).toBe('file.txt');
      expect(call[0]).toBe('https://proxy.void.cloud/r2/delete');
    });

    it('deletes multiple keys', async () => {
      mockFetch({ success: true });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      await r2.delete(['a.txt', 'b.txt']);

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.keys).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('list()', () => {
    it('returns objects and pagination info', async () => {
      mockFetch({
        objects: [
          { key: 'file1.txt', size: 100, lastModified: '2024-01-01T00:00:00Z' },
          { key: 'file2.txt', size: 200, lastModified: '2024-01-02T00:00:00Z' },
        ],
        truncated: false,
        cursor: null,
      });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const result = await r2.list({ prefix: 'files/' });

      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].key).toBe('file1.txt');
      expect(result.objects[1].key).toBe('file2.txt');
      expect(result.truncated).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://proxy.void.cloud/r2/list',
        expect.anything(),
      );
    });

    it('passes startAfter and include and returns prefixes through the binding handler', async () => {
      const list = vi.fn(async () => ({
        objects: [stored],
        truncated: false,
        delimitedPrefixes: ['dir/'],
      }));
      const r2 = connectBucket({ list });

      const result = await r2.list({
        delimiter: '/',
        startAfter: 'a',
        include: ['httpMetadata', 'customMetadata'],
      });

      expect(list).toHaveBeenCalledWith({
        delimiter: '/',
        startAfter: 'a',
        include: ['httpMetadata', 'customMetadata'],
      });
      expect(result.delimitedPrefixes).toEqual(['dir/']);
      expect(result.objects[0]).toMatchObject({
        etag: 'abc',
        version: 'v1',
        uploaded,
        httpMetadata: { cacheControl: 'max-age=60' },
        customMetadata: { owner: 'x' },
      });
    });

    it.each<[string, R2ListOptions]>([
      ['delimiter', { delimiter: '/' }],
      ['startAfter', { startAfter: 'a' }],
      ['include', { include: ['customMetadata'] }],
    ])('rejects %s when the response has no prefixes', async (_name, options) => {
      mockFetch({ objects: [], truncated: false, cursor: null });

      await expect(new ProxyR2Bucket(createClient(), 'STORAGE').list(options)).rejects.toThrow(
        'got no answer from a current project deployment. The deployment uses an older Void version, or the platform could not reach it. Retry.',
      );
    });

    it('returns cursor when truncated', async () => {
      mockFetch({
        objects: [{ key: 'file1.txt', size: 100, lastModified: '' }],
        truncated: true,
        cursor: 'next-page',
      });

      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      const result = await r2.list({ limit: 1 });

      expect(result.truncated).toBe(true);
      expect((result as typeof result & { cursor: string | null }).cursor).toBe('next-page');
    });
  });

  describe('unsupported methods', () => {
    it('createMultipartUpload throws', () => {
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      expect(() =>
        (
          r2 as ProxyR2Bucket & { createMultipartUpload(key: string): unknown }
        ).createMultipartUpload('key'),
      ).toThrow('not supported with remote bindings');
    });

    it('resumeMultipartUpload throws', () => {
      const r2 = new ProxyR2Bucket(createClient(), 'STORAGE');
      expect(() =>
        (
          r2 as ProxyR2Bucket & {
            resumeMultipartUpload(key: string, uploadId: string): unknown;
          }
        ).resumeMultipartUpload('key', 'id'),
      ).toThrow('not supported with remote bindings');
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  DEPLOY_POST_ATTEMPTS,
  PlatformClient,
  type ManifestOnlyDeployPayload,
} from '../../src/cli/client.ts';
import type { DeployManifest } from '../../src/cli/types.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const accessKeyring = vi.hoisted(() => ({
  read: vi.fn((): string | null => null),
  write: vi.fn(() => true),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: (...args: Array<unknown>) => spawnSyncMock(...args),
}));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: accessKeyring.read,
  writeKeyringPassword: accessKeyring.write,
}));

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

const apiUrl = 'https://api.test';
const projectId = 'proj_test';
const token = 'auth-token-x';

function makeClient(): PlatformClient {
  return new PlatformClient(token, { apiUrl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The platform names the accepted deployment in a receipt header before streaming. */
function receiptFor(events: Array<unknown>): string {
  for (const event of events as Array<{ deploymentId?: unknown; deployment?: unknown }>) {
    const id = event.deploymentId ?? event.deployment;
    if (typeof id === 'string') {
      return id;
    }
  }
  return 'dpl_durable';
}

function ndjsonStreamResponse(events: Array<unknown>, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      'content-type': 'application/x-ndjson',
      'x-void-deployment-id': receiptFor(events),
    },
  });
}

describe('PlatformClient.requestUploadUrls', () => {
  it('POSTs JSON to /:id/deploy/upload-urls and returns the urls map', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        urls: {
          aabbccdd: { url: 'https://r2/.../1', headers: { 'Content-Md5': 'abc==' } },
        },
      }),
    );

    const client = makeClient();
    const urls = await client.requestUploadUrls(projectId, [
      { blake3: 'aabbccdd', md5: '11223344', size: 17, contentType: 'text/plain' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/deploy/upload-urls`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    // Version header so the platform's cliVersionGate middleware can refuse
    // stale CLIs cleanly (HTTP 426 + cli_outdated). Format must look like a
    // semver triplet — exact value is package.json-driven.
    expect(headers['X-Void-CLI-Version']).toMatch(/^\d+\.\d+\.\d+/);

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      assets: [{ blake3: 'aabbccdd', md5: '11223344', size: 17, contentType: 'text/plain' }],
    });

    expect(urls).toEqual({
      aabbccdd: { url: 'https://r2/.../1', headers: { 'Content-Md5': 'abc==' } },
    });
  });
});

describe('PlatformClient.requestWorkerUploadUrls', () => {
  const modules = [
    { name: 'index.js', size: 18, sha256: 'a'.repeat(64) },
    { name: 'chunks/b.js', size: 4, sha256: 'b'.repeat(64) },
  ];
  const urls = [
    { url: 'https://r2/worker/0', headers: { 'Content-Type': 'application/javascript' } },
    { url: 'https://r2/worker/1', headers: { 'Content-Type': 'application/javascript' } },
  ];

  it('POSTs the modules in order and returns the upload id and URLs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'wup_1', urls }));

    await expect(makeClient().requestWorkerUploadUrls(projectId, modules)).resolves.toEqual({
      id: 'wup_1',
      urls,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/deploy/worker-upload-urls`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body as string)).toEqual({ modules });
  });

  it("shows the platform's message when the Worker is over the size limit", async () => {
    const message = 'This Worker is 70 MB without source maps. Cloudflare allows at most 64 MiB.';
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'worker_too_large', message }, 413));

    const request = makeClient().requestWorkerUploadUrls(projectId, modules);
    await expect(request).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 413,
      code: 'worker_too_large',
    });
    await expect(request).rejects.toThrow(message);
  });

  it.each([
    ['without an id', { urls }],
    ['with fewer URLs than modules', { id: 'wup_1', urls: urls.slice(1) }],
    ['with a malformed URL entry', { id: 'wup_1', urls: [urls[0], { url: 'https://r2/x' }] }],
  ])('rejects a response %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    await expect(makeClient().requestWorkerUploadUrls(projectId, modules)).rejects.toThrow(
      'Invalid worker upload URLs from platform.',
    );
  });
});

describe('PlatformClient.getMigrationStatus', () => {
  it('passes the dialect query parameter when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ applied: [] }));

    const client = makeClient();
    await client.getMigrationStatus(projectId, 'postgresql');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(`${apiUrl}/projects/${projectId}/migrations?dialect=postgresql`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
  });
});

describe('PlatformClient.finalizeDeploy', () => {
  const baseManifest: DeployManifest = {
    version: 3,
    assetManifestVersion: 2,
    bindings: {},
    type: 'spa',
    assetConfig: { not_found_handling: 'single-page-application' },
  };

  function makePayload(): ManifestOnlyDeployPayload {
    return {
      manifest: baseManifest,
      assetManifest: {
        '/index.html': {
          blake3: 'a'.repeat(32),
          md5: 'b'.repeat(32),
          size: 12,
          hash: 'a'.repeat(32),
        },
      },
      source: 'manual',
      commit: null,
      repositoryUrl: null,
      commitUrl: null,
      gitRef: null,
      preflight: 'true',
    };
  }

  it('POSTs JSON (NOT multipart) to /:id/deploy and parses the NDJSON event stream', async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonStreamResponse([
        { event: 'start', deploymentId: 'dep_x' },
        { event: 'asset_upload', total: 1, new: 0, cached: 1 },
        {
          event: 'done',
          deployment: 'dep_x',
          url: 'https://x.void.app',
          urls: [],
          assets: 1,
          workers: 0,
        },
      ]),
    );

    const client = makeClient();
    const events = [];
    for await (const event of client.finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }

    // Verify wire shape: JSON, not multipart.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${apiUrl}/projects/${projectId}/deploy`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(typeof init.body).toBe('string');
    const parsed = JSON.parse(init.body as string);
    expect(parsed.manifest).toEqual(baseManifest);
    expect(parsed.assetManifest['/index.html']).toMatchObject({
      blake3: 'a'.repeat(32),
      md5: 'b'.repeat(32),
      size: 12,
    });
    expect(parsed.preflight).toBe('true');

    // Verify all events were yielded in order, parsed from NDJSON.
    expect(events).toEqual([
      { event: 'start', deploymentId: 'dep_x' },
      { event: 'asset_upload', total: 1, new: 0, cached: 1 },
      {
        event: 'done',
        deployment: 'dep_x',
        url: 'https://x.void.app',
        urls: [],
        assets: 1,
        workers: 0,
      },
    ]);
  });

  it('handles NDJSON split across chunk boundaries', async () => {
    // Hand-craft a stream that splits the second event mid-way.
    const lines = [
      `${JSON.stringify({ event: 'start', deploymentId: 'd1' })}\n`,
      `${JSON.stringify({ event: 'heartbeat', step: 'preflight' })}`,
      `\n${JSON.stringify({ event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 })}\n`,
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines[0] + lines[1]));
        controller.enqueue(encoder.encode(lines[2]));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson', 'x-void-deployment-id': 'd1' },
      }),
    );

    const client = makeClient();
    const events = [];
    for await (const event of client.finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }

    expect(events.map((e) => (e as { event?: string }).event)).toEqual([
      'start',
      'heartbeat',
      'done',
    ]);
  });

  function makeCliLog() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      path: '/tmp/test.jsonl',
      close: vi.fn(),
    };
  }

  const deployPostCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/deploy'));
  const deploymentListCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/deployments'));

  it('retries a transport-level fetch rejection with backoff, then streams events', async () => {
    vi.useFakeTimers();
    let posts = 0;
    fetchMock.mockImplementation(() => {
      posts++;
      if (posts === 1) {
        return Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
          }),
        );
      }
      return Promise.resolve(
        ndjsonStreamResponse([
          { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
        ]),
      );
    });

    const cliLog = makeCliLog();
    const client = new PlatformClient(token, { apiUrl, cliLog });
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, makePayload())) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      // No client-side dedupe GET — the server's precheck is authoritative.
      expect(deploymentListCalls()).toHaveLength(0);
      expect(events).toEqual([
        { event: 'start', deploymentId: 'd1' },
        { event: 'done', deployment: 'd1', url: 'https://x', urls: [], assets: 0, workers: 0 },
      ]);
      expect(cliLog.warn).toHaveBeenCalledWith(
        'deploy_fetch_retry',
        expect.objectContaining({ attempt: 1, delayMs: 1000 }),
      );
      expect(cliLog.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the server 409 as an error event when a deploy is already in progress', async () => {
    vi.useFakeTimers();
    // The replay hits the authoritative concurrency guard — possibly the
    // earlier attempt of this same deploy, or a concurrent one.
    let posts = 0;
    fetchMock.mockImplementation(() => {
      posts++;
      if (posts === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        jsonResponse({ error: 'deploy in progress', deployment: 'dpl_conflict' }, 409),
      );
    });

    const cliLog = makeCliLog();
    const client = new PlatformClient(token, { apiUrl, cliLog });
    try {
      const events: Array<unknown> = [];
      const consume = (async () => {
        for await (const event of client.finalizeDeploy(projectId, makePayload())) {
          events.push(event);
        }
      })();
      await vi.runAllTimersAsync();
      await consume;

      expect(deployPostCalls()).toHaveLength(2);
      expect(events).toEqual([
        {
          event: 'error',
          step: 'finalize',
          message: expect.stringContaining('dpl_conflict'),
        },
      ]);
      expect(cliLog.warn).toHaveBeenCalledWith(
        'deploy_conflict',
        expect.objectContaining({ deploymentId: 'dpl_conflict' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a first-attempt 409 without retrying', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'deploy in progress', deployment: 'dpl_busy' }, 409),
    );

    const client = makeClient();
    const events: Array<unknown> = [];
    for await (const event of client.finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }

    expect(deployPostCalls()).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'error',
      message: expect.stringContaining('dpl_busy'),
    });
  });

  it('throws the platform error for a 409 without a deployment id', async () => {
    fetchMock.mockResolvedValue(new Response('conflict', { status: 409 }));
    const client = makeClient();
    const gen = client.finalizeDeploy(projectId, makePayload());
    await expect(gen.next()).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transport rejections (e.g. AbortError)', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
    const client = makeClient();
    const gen = client.finalizeDeploy(projectId, makePayload());
    await expect(gen.next()).rejects.toBeInstanceOf(DOMException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  function headersTimeoutError() {
    const cause = Object.assign(new Error('Headers Timeout Error'), {
      name: 'HeadersTimeoutError',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    return { cause, error: new TypeError('fetch failed', { cause }) };
  }

  const idempotencyKeys = () =>
    deployPostCalls().map(
      ([, init]) => (init.headers as Record<string, string>)['x-void-deploy-idempotency-key'],
    );

  it('retries a headers timeout with the same idempotency key, then rethrows it', async () => {
    const { cause, error } = headersTimeoutError();
    fetchMock.mockRejectedValue(error);

    vi.useFakeTimers();
    const cliLog = makeCliLog();
    const client = new PlatformClient(token, { apiUrl, cliLog });
    try {
      const assertion = expect(
        client.finalizeDeploy(projectId, makePayload()).next(),
      ).rejects.toMatchObject({ message: 'fetch failed', cause });
      await vi.runAllTimersAsync();
      await assertion;

      expect(deployPostCalls()).toHaveLength(4);
      expect(DEPLOY_POST_ATTEMPTS).toBe(4);
      expect(new Set(idempotencyKeys()).size).toBe(1);
      const retries = cliLog.warn.mock.calls.filter(([msg]) => msg === 'deploy_fetch_retry');
      expect(retries.map(([, fields]) => fields?.delayMs)).toEqual([1000, 5000, 10000]);
      expect(cliLog.error).toHaveBeenCalledWith(
        'deploy_fetch_rejected',
        expect.any(TypeError),
        expect.objectContaining({ url: `${apiUrl}/projects/${projectId}/deploy`, attempts: 4 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the existing deployment receipt returned to a retry after a headers timeout', async () => {
    const done = {
      event: 'done',
      deployment: 'dpl_existing',
      url: 'https://x.void.app',
      urls: [],
      assets: 1,
      workers: 1,
      seq: 3,
    };
    fetchMock
      .mockRejectedValueOnce(headersTimeoutError().error)
      .mockResolvedValueOnce(
        ndjsonStreamResponse([
          { event: 'start', deploymentId: 'dpl_existing', seq: 1 },
          { event: 'worker_upload', seq: 2 },
          done,
        ]),
      );

    vi.useFakeTimers();
    try {
      const deploy = collectDeploy();
      await vi.runAllTimersAsync();
      expect(await deploy).toEqual([
        { event: 'start', deploymentId: 'dpl_existing' },
        { event: 'worker_upload', seq: 2 },
        done,
      ]);
      expect(deployPostCalls()).toHaveLength(2);
      const [first, second] = idempotencyKeys();
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry HTTP error responses — the server answered', async () => {
    fetchMock.mockResolvedValue(new Response('busted', { status: 503 }));
    const client = makeClient();
    const gen = client.finalizeDeploy(projectId, makePayload());
    await expect(gen.next()).rejects.toMatchObject({
      name: 'PlatformApiError',
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes workerFiles as base64 in the JSON body', async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonStreamResponse([
        {
          event: 'done',
          deployment: 'd1',
          url: 'https://x',
          urls: [],
          assets: 0,
          workers: 1,
        },
      ]),
    );

    const client = makeClient();
    const payload = makePayload();
    payload.workerFiles = {
      'index.mjs': Buffer.from('export default {};').toString('base64'),
    };

    for await (const _event of client.finalizeDeploy(projectId, payload)) {
      // no-op — we only need the request body
    }

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(init.body as string);
    expect(parsed.workerFiles).toEqual({
      'index.mjs': Buffer.from('export default {};').toString('base64'),
    });
  });

  function durableResponse(events: Array<unknown>): Response {
    const response = ndjsonStreamResponse(events);
    response.headers.set('x-void-deployment-id', 'dpl_durable');
    return response;
  }

  const durableDone = {
    event: 'done',
    deployment: 'dpl_durable',
    url: 'https://durable.void.app',
    urls: ['https://durable.void.app'],
    assets: 1,
    workers: 0,
    published: false,
  };

  function eventPage(events: Array<{ seq: number; event: unknown }>, terminal = true): Response {
    return jsonResponse({
      deploymentId: 'dpl_durable',
      events,
      lastSeq: events.at(-1)?.seq ?? 0,
      terminal,
    });
  }

  async function collectDeploy(): Promise<Array<unknown>> {
    const events: Array<unknown> = [];
    for await (const event of makeClient().finalizeDeploy(projectId, makePayload())) {
      events.push(event);
    }
    return events;
  }

  it('re-sends the same workerInput and idempotency key on a transport retry', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ndjsonStreamResponse([durableDone]));
    const workerInput = {
      id: 'wup_retry',
      modules: [{ name: 'index.js', size: 18, sha256: 'c'.repeat(64) }],
    };
    try {
      const deploy = (async () => {
        for await (const _event of makeClient().finalizeDeploy(projectId, {
          ...makePayload(),
          workerInput,
        })) {
          // Only the request bodies matter here.
        }
      })();
      await vi.runAllTimersAsync();
      await deploy;

      const [first, second] = deployPostCalls().map(([, init]) => init as RequestInit);
      expect(second.body).toBe(first.body);
      expect(JSON.parse(first.body as string)).toMatchObject({ workerInput });
      expect(JSON.parse(first.body as string)).not.toHaveProperty('workerFiles');
      const [firstKey, secondKey] = idempotencyKeys();
      expect(firstKey).toMatch(/^[a-f0-9-]{36}$/);
      expect(secondKey).toBe(firstKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one idempotency key across POST retries and chooses a new key for each invocation', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ndjsonStreamResponse([durableDone]))
      .mockResolvedValueOnce(ndjsonStreamResponse([durableDone]));
    try {
      const first = collectDeploy();
      await vi.runAllTimersAsync();
      await first;
      await collectDeploy();
      const keys = fetchMock.mock.calls.map(
        ([, init]) => (init.headers as Record<string, string>)['x-void-deploy-idempotency-key'],
      );
      expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers the exact accepted deployment when EOF precedes start, preserving published:false', async () => {
    fetchMock.mockResolvedValueOnce(durableResponse([])).mockResolvedValueOnce(
      eventPage([
        { seq: 1, event: { event: 'start', deploymentId: 'dpl_durable' } },
        { seq: 2, event: durableDone },
      ]),
    );
    expect(await collectDeploy()).toEqual([
      { event: 'start', deploymentId: 'dpl_durable' },
      durableDone,
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${apiUrl}/projects/${projectId}/deployments/dpl_durable/events?since=0`,
    );
    expect(deployPostCalls()).toHaveLength(1);
  });

  it('reconnects after a read failure from the last consumed sequence without duplicating progress', async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ event: 'start', deploymentId: 'dpl_durable', seq: 1 })}\n` +
                `${JSON.stringify({ event: 'worker_readiness', seq: 2 })}\n`,
            ),
          );
        } else {
          controller.error(new Error('socket disconnected'));
        }
      },
    });
    const response = new Response(stream, {
      headers: { 'x-void-deployment-id': 'dpl_durable' },
    });
    fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(
      eventPage([
        { seq: 2, event: { event: 'worker_readiness' } },
        { seq: 3, event: durableDone },
      ]),
    );
    expect(await collectDeploy()).toEqual([
      { event: 'start', deploymentId: 'dpl_durable' },
      { event: 'worker_readiness', seq: 2 },
      durableDone,
    ]);
    expect(fetchMock.mock.calls[1][0]).toContain('/dpl_durable/events?since=2');
    expect(deployPostCalls()).toHaveLength(1);
    expect(response.body!.locked).toBe(false);
  });

  it('observes the operation receipt when a verified no-op returns the existing active deployment', async () => {
    const noOp = { ...durableDone, deployment: 'dpl_existing' };
    fetchMock.mockResolvedValueOnce(durableResponse([])).mockResolvedValueOnce(
      eventPage([
        { seq: 1, event: { event: 'start', deploymentId: 'dpl_existing' } },
        { seq: 2, event: noOp },
      ]),
    );
    expect(await collectDeploy()).toEqual([{ event: 'start', deploymentId: 'dpl_durable' }, noOp]);
    expect(fetchMock.mock.calls[1][0]).toContain('/dpl_durable/events?since=0');
    expect(deployPostCalls()).toHaveLength(1);
  });

  it('retries transient observation errors from the same cursor and consumes partial pages', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(durableResponse([{ event: 'worker_readiness', seq: 2 }]))
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(
        eventPage([{ seq: 3, event: { event: 'worker_upload', modules: 1 } }], false),
      )
      .mockResolvedValueOnce(eventPage([{ seq: 4, event: durableDone }]));
    try {
      const result = collectDeploy();
      await vi.runAllTimersAsync();
      expect(await result).toEqual([
        { event: 'start', deploymentId: 'dpl_durable' },
        { event: 'worker_readiness', seq: 2 },
        { event: 'worker_upload', modules: 1 },
        durableDone,
      ]);
      expect(fetchMock.mock.calls.slice(1).map(([url]) => String(url).split('?')[1])).toEqual([
        'since=2',
        'since=2',
        'since=2',
        'since=3',
      ]);
      expect(deployPostCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403, 404, 426])(
    'preserves fatal observation HTTP %i without retrying or redeploying',
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(durableResponse([]))
        .mockResolvedValueOnce(
          jsonResponse(
            { error: 'observation denied', message: 'Actionable platform message.' },
            status,
          ),
        );
      await expect(collectDeploy()).rejects.toMatchObject({
        name: 'PlatformApiError',
        status,
        message: expect.stringContaining('Actionable platform message.'),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(deployPostCalls()).toHaveLength(1);
    },
  );

  it('bounds consecutive observation retries and retains the final platform error', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(durableResponse([]))
      .mockImplementation(async () => jsonResponse({ error: 'unavailable' }, 503));
    try {
      const assertion = expect(collectDeploy()).rejects.toMatchObject({
        name: 'PlatformApiError',
        status: 503,
      });
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(7);
      expect(deployPostCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a deployment stream without a receipt and does not observe or retry it', async () => {
    const response = ndjsonStreamResponse([{ event: 'start', deploymentId: 'dpl_unknown' }]);
    response.headers.delete('x-void-deployment-id');
    const cancel = vi.spyOn(response.body!, 'cancel');
    fetchMock.mockResolvedValueOnce(response);
    await expect(collectDeploy()).rejects.toThrow('Platform returned no deployment receipt.');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a persisted cancellation error instead of reporting successful acceptance', async () => {
    const canceled = { event: 'error', step: 'canceling', message: 'deployment canceled' };
    fetchMock
      .mockResolvedValueOnce(durableResponse([]))
      .mockResolvedValueOnce(eventPage([{ seq: 1, event: canceled }]));
    expect(await collectDeploy()).toEqual([
      { event: 'start', deploymentId: 'dpl_durable' },
      canceled,
    ]);
    expect(deployPostCalls()).toHaveLength(1);
  });

  it('bounds observation of a platform that never reports completion', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    fetchMock.mockResolvedValueOnce(durableResponse([])).mockImplementation(async () => {
      vi.setSystemTime(startedAt + 30 * 60_000);
      return eventPage([], false);
    });
    try {
      const assertion = expect(collectDeploy()).rejects.toThrow(
        'Timed out observing deployment dpl_durable',
      );
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(deployPostCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds an open deployment stream even while heartbeats continue', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let reads = 0;
    const startedAt = Date.now();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          vi.setSystemTime(startedAt + reads++ * 15 * 60_000);
          controller.enqueue(
            new TextEncoder().encode('{"event":"heartbeat","step":"queue_setup"}\n'),
          );
          // Close this finite fixture so a missing deadline produces a failed
          // assertion instead of hanging the regression test indefinitely.
          if (reads === 4) {
            controller.close();
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { headers: { 'x-void-deployment-id': 'dpl_durable' } }),
    );
    fetchMock.mockResolvedValueOnce(eventPage([{ seq: 1, event: durableDone }]));
    try {
      await expect(collectDeploy()).rejects.toThrow('Timed out observing deployment dpl_durable');
      expect(deployPostCalls()).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the original observation deadline when reconnecting after a long stream', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const response = new Response(
      new ReadableStream(
        {
          pull(controller) {
            vi.setSystemTime(startedAt + 29 * 60_000);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'x-void-deployment-id': 'dpl_durable' } },
    );
    let polls = 0;
    fetchMock.mockResolvedValueOnce(response).mockImplementation(async () => {
      vi.setSystemTime(startedAt + 30 * 60_000);
      return polls++ === 0 ? eventPage([], false) : eventPage([{ seq: 1, event: durableDone }]);
    });
    try {
      const assertion = expect(collectDeploy()).rejects.toThrow(
        'Timed out observing deployment dpl_durable',
      );
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(deployPostCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports recovery heartbeats after reconnecting to a deployment receipt', async () => {
    vi.useFakeTimers();
    const heartbeat = {
      event: 'heartbeat',
      deploymentId: 'dpl_durable',
      status: 'recovering',
      step: 'recovery',
      recoveryAt: new Date(Date.now() + 60_000).toISOString(),
    };
    fetchMock
      .mockResolvedValueOnce(durableResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({
          deploymentId: 'dpl_durable',
          events: [],
          lastSeq: 0,
          terminal: false,
          heartbeat,
        }),
      )
      .mockResolvedValueOnce(eventPage([{ seq: 1, event: durableDone }]));
    try {
      const result = collectDeploy();
      await vi.runAllTimersAsync();
      expect(await result).toEqual([
        { event: 'start', deploymentId: 'dpl_durable' },
        heartbeat,
        durableDone,
      ]);
      expect(deployPostCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { event: 'done' },
    { event: 'heartbeat', step: 'recovery', deploymentId: 'dpl_other' },
    { event: 'heartbeat', step: 'recovery', status: 'invalid' },
    { event: 'heartbeat', step: 'recovery', recoveryAt: 'invalid' },
  ])('rejects invalid recovery metadata without resubmitting deployment: %j', async (heartbeat) => {
    fetchMock.mockResolvedValueOnce(durableResponse([])).mockResolvedValueOnce(
      jsonResponse({
        deploymentId: 'dpl_durable',
        events: [],
        lastSeq: 0,
        terminal: false,
        heartbeat,
      }),
    );
    await expect(collectDeploy()).rejects.toThrow(/Invalid deployment/);
    expect(deployPostCalls()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels and releases an open response after terminal delivery', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(durableDone)}\n`));
      },
      cancel,
    });
    const response = new Response(stream, { headers: { 'x-void-deployment-id': 'dpl_durable' } });
    fetchMock.mockResolvedValueOnce(response);
    expect(await collectDeploy()).toEqual([
      { event: 'start', deploymentId: 'dpl_durable' },
      durableDone,
    ]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers from a stalled stream and does not wait for a stalled cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'x-void-deployment-id': 'dpl_durable' },
    });
    fetchMock
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(eventPage([{ seq: 1, event: durableDone }]));
    try {
      const result = collectDeploy();
      await vi.runAllTimersAsync();
      expect(await result).toEqual([{ event: 'start', deploymentId: 'dpl_durable' }, durableDone]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body!.locked).toBe(false);
      expect(deployPostCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized unfinished line, closes its reader, and does not mask it with reconnect', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1).fill(120));
        },
        cancel,
      }),
      { headers: { 'x-void-deployment-id': 'dpl_durable' } },
    );
    fetchMock.mockResolvedValueOnce(response);
    await expect(collectDeploy()).rejects.toThrow('response limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses a final complete event without a trailing newline', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(durableDone), {
        headers: { 'x-void-deployment-id': 'dpl_durable' },
      }),
    );
    expect(await collectDeploy()).toEqual([
      { event: 'start', deploymentId: 'dpl_durable' },
      durableDone,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { deploymentId: 'dpl_other', events: [], lastSeq: 0, terminal: false },
    {
      deploymentId: 'dpl_durable',
      events: [{ seq: 1, event: { ...durableDone, url: null } }],
      lastSeq: 1,
      terminal: true,
    },
    { deploymentId: 'dpl_durable', events: [], lastSeq: 0, terminal: true },
    {
      deploymentId: 'dpl_durable',
      events: [{ seq: 2, event: durableDone }],
      lastSeq: 1,
      terminal: true,
    },
  ])('fails closed on invalid observation response %#', async (page) => {
    fetchMock.mockResolvedValueOnce(durableResponse([])).mockResolvedValueOnce(jsonResponse(page));
    await expect(collectDeploy()).rejects.toThrow(/Invalid deployment|without a terminal result/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// The deploy command keeps the CF Access service-token pair out of untrusted
// build children (via `buildEnv()` on the spawn env). That is only safe because
// the client captures the Access headers at construction and reuses them.
describe('PlatformClient CF Access header capture (survives a later env scrub)', () => {
  it('keeps sending CF-Access headers after CF_ACCESS_* are deleted from process.env', async () => {
    vi.stubEnv('VOID_ACCESS_ORIGIN', 'https://api.staging.void.cloud');
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'svc-id.access');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'svc-secret');
    const client = new PlatformClient(token, { apiUrl: 'https://api.staging.void.cloud' });

    vi.stubEnv('CF_ACCESS_CLIENT_ID', undefined);
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', undefined);

    fetchMock.mockResolvedValueOnce(jsonResponse({ urls: {} }));
    await client.requestUploadUrls(projectId, [
      { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBe('svc-id.access');
    expect(headers['CF-Access-Client-Secret']).toBe('svc-secret');
  });

  it('does not send staging Access credentials to a self-hosted platform', async () => {
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'svc-id.access');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'svc-secret');
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ urls: {} }));

    await client.requestUploadUrls(projectId, [
      { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBeUndefined();
    expect(headers['CF-Access-Client-Secret']).toBeUndefined();
  });

  it('uses a browser-renewed Access token acquired after construction', async () => {
    vi.stubEnv('CF_ACCESS_CLIENT_ID', undefined);
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', undefined);
    vi.stubEnv('VOID_ACCESS_CREDENTIALS', undefined);
    vi.stubEnv('VOID_ACCESS_ORIGIN', 'https://api.staging.void.cloud');
    const tokenFor = (label: string) =>
      'header.' +
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, label })).toString(
        'base64url',
      ) +
      '.signature';
    vi.stubEnv('CF_ACCESS_TOKEN', tokenFor('initial'));
    const client = new PlatformClient(token, { apiUrl: 'https://api.staging.void.cloud' });

    const renewedToken = tokenFor('renewed');
    vi.stubEnv('CF_ACCESS_TOKEN', renewedToken);
    fetchMock.mockResolvedValueOnce(jsonResponse({ urls: {} }));
    await client.requestUploadUrls(projectId, [
      { blake3: 'a'.repeat(32), md5: 'b'.repeat(32), size: 1, contentType: 'text/plain' },
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['cf-access-token']).toBe(renewedToken);
    expect(headers['CF-Access-Client-Id']).toBeUndefined();
  });
});

describe('PlatformClient Cloudflare Access challenge renewal', () => {
  const origin = 'https://api.example.com';
  const accessJwt = (seconds: number) =>
    `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.signature`;
  let stdinTty: boolean | undefined;
  let stdoutTty: boolean | undefined;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    accessKeyring.read.mockReset().mockReturnValue(null);
    accessKeyring.write.mockReset().mockReturnValue(true);
    stdinTty = process.stdin.isTTY;
    stdoutTty = process.stdout.isTTY;
    vi.stubEnv('VOID_ACCESS_ORIGIN', undefined);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty });
  });

  it('renews a rejected human token and retries once at the original API endpoint', async () => {
    const stale = accessJwt(600);
    const fresh = accessJwt(900);
    vi.stubEnv('VOID_ACCESS_CREDENTIALS', JSON.stringify({ [origin]: { CF_ACCESS_TOKEN: stale } }));
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    spawnSyncMock.mockImplementation((_command, args: Array<string>) =>
      args[1] === 'login' ? { status: 0, stdout: '' } : { status: 0, stdout: fresh },
    );
    const challengeLocation =
      'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com';
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: challengeLocation } }),
      )
      .mockResolvedValueOnce(jsonResponse([]));

    await expect(new PlatformClient(token, { apiUrl: origin }).listProjects()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/projects`,
      `${origin}/projects`,
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).redirect)).toEqual([
      'manual',
      'manual',
    ]);
    const firstHeaders = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(firstHeaders['cf-access-token']).toBe(stale);
    expect(secondHeaders['cf-access-token']).toBe(fresh);
    expect(secondHeaders['CF-Access-Client-Id']).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => url === challengeLocation)).toBe(false);
  });

  it('does not retry ambiguous API errors', async () => {
    vi.stubEnv(
      'VOID_ACCESS_CREDENTIALS',
      JSON.stringify({ [origin]: { CF_ACCESS_TOKEN: accessJwt(600) } }),
    );
    fetchMock.mockResolvedValueOnce(new Response('application failure', { status: 500 }));

    await expect(
      new PlatformClient(token, { apiUrl: origin }).listProjects(),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not replace a rejected scoped service credential with a human login', async () => {
    vi.stubEnv(
      'VOID_ACCESS_CREDENTIALS',
      JSON.stringify({
        [origin]: { CF_ACCESS_CLIENT_ID: 'ci-client', CF_ACCESS_CLIENT_SECRET: 'ci-secret' },
      }),
    );
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const client = new PlatformClient(token, { apiUrl: origin });
    vi.stubEnv('VOID_ACCESS_CREDENTIALS', undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com',
        },
      }),
    );

    await expect(client.listProjects()).rejects.toMatchObject({ status: 302 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

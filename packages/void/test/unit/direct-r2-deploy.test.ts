import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpinnerResult } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DeployManifest } from '../../src/cli/types.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

// Spy on `readFileSync` to count asset reads. Mocked before any importer of
// `node:fs` so `package.ts` binds to the spy.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) =>
      actual.readFileSync(...args),
    ),
  };
});

// `@voidzero-dev/vite-plus-prompts` opens TTY-bound spinners we don't want to render in tests.
const noopSpinner = {
  start: vi.fn(),
  stop: vi.fn(),
  message: vi.fn(),
  clear: vi.fn(),
};
vi.mock('@voidzero-dev/vite-plus-prompts', async () => {
  const actual = await vi.importActual<typeof import('@voidzero-dev/vite-plus-prompts')>(
    '@voidzero-dev/vite-plus-prompts',
  );
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
    },
    spinner: () => noopSpinner,
  };
});

// `output.ts` wraps clack's spinner — re-export the same noop. Used by
// runStaticDeploy through `createSpinner()`.
vi.mock('../../src/cli/output.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/cli/output.ts')>('../../src/cli/output.ts');
  return {
    ...actual,
    createSpinner: () => noopSpinner,
  };
});

const fsModule = await import('node:fs');
const readFileSyncMock = fsModule.readFileSync as unknown as ReturnType<typeof vi.fn>;

const { runStaticDeploy } = await import('../../src/cli/deploy-managed-static.ts');
const { streamDirectR2Deploy } = await import('../../src/cli/deploy-managed-events.ts');
const { collectAndHashAssets } = await import('../../src/cli/package.ts');
const { openDeployLog } = await import('../../src/cli/log-file.ts');
const { PlatformClient } = await import('../../src/cli/client.ts');

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;

let workdir: string;
let assetsDir: string;
const fixtureFiles: Record<string, string | Buffer> = {
  '/index.html': '<!doctype html><html><body>hi</body></html>\n',
  '/style.css': 'body { color: red; }\n',
  '/script.js': 'console.log("hello");\n',
  // Larger asset (>100KB) to stress buffer threading.
  '/large.bin': Buffer.alloc(120_000, 0xa5),
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'void-direct-r2-'));
  assetsDir = join(workdir, 'dist');
  mkdirSync(assetsDir, { recursive: true });
  for (const [relPath, content] of Object.entries(fixtureFiles)) {
    writeFileSync(join(assetsDir, relPath.slice(1)), content);
  }

  originalFetch = globalThis.fetch;
  globalThis.fetch = withPlatformDiscovery(fetchMock);
  fetchMock.mockReset();
  readFileSyncMock.mockClear();
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

type WorkerModule = { name: string; size: number; sha256: string };

type MockState = {
  preflightCalls: Array<unknown>;
  uploadUrlsCalls: Array<unknown>;
  workerUploadUrlsCalls: Array<{ modules: Array<WorkerModule> }>;
  r2PutCalls: Array<{ url: string; init: RequestInit }>;
  finalizeCalls: Array<{ url: string; init: RequestInit }>;
};

/** Headers the mock platform signs into each Worker module's PUT. */
function workerPutHeaders(module: WorkerModule): Record<string, string> {
  return {
    'Content-Type': 'application/javascript+module',
    'Content-Length': String(module.size),
    'x-amz-checksum-sha256': Buffer.from(module.sha256, 'hex').toString('base64'),
  };
}

function installPlatformMocks(opts?: {
  preflightSkipped?: number;
  preflightNeeded?: Array<string>;
  r2PutBehavior?: (url: string) => Response | Promise<Response>;
  workerUploadUrls?: () => Response;
  finalizeEvents?: Array<unknown>;
}): MockState {
  const state: MockState = {
    preflightCalls: [],
    uploadUrlsCalls: [],
    workerUploadUrlsCalls: [],
    r2PutCalls: [],
    finalizeCalls: [],
  };

  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const reqInit = init ?? {};
    const method = reqInit.method ?? 'GET';

    if (url.endsWith('/deploy/preflight') && method === 'POST') {
      state.preflightCalls.push(JSON.parse(reqInit.body as string));
      return new Response(
        JSON.stringify({
          needed: opts?.preflightNeeded ?? Object.keys(fixtureFiles),
          total: Object.keys(fixtureFiles).length,
          skipped: opts?.preflightSkipped ?? 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.endsWith('/deploy/upload-urls') && method === 'POST') {
      const body = JSON.parse(reqInit.body as string) as {
        assets: Array<{ blake3: string; md5: string; contentType: string }>;
      };
      state.uploadUrlsCalls.push(body);
      const urls: Record<string, { url: string; headers: Record<string, string> }> = {};
      for (const asset of body.assets) {
        urls[asset.blake3] = {
          url: `https://r2-test/${asset.blake3}`,
          headers: {
            'Content-Md5': hexToBase64(asset.md5),
            'Content-Type': asset.contentType,
          },
        };
      }
      return new Response(JSON.stringify({ urls }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.endsWith('/deploy/worker-upload-urls') && method === 'POST') {
      const body = JSON.parse(reqInit.body as string) as { modules: Array<WorkerModule> };
      state.workerUploadUrlsCalls.push(body);
      if (opts?.workerUploadUrls) {
        return opts.workerUploadUrls();
      }
      return Response.json({
        id: 'wup_test',
        urls: body.modules.map((module, index) => ({
          url: `https://r2-test/worker/${index}`,
          headers: workerPutHeaders(module),
        })),
      });
    }

    if (url.startsWith('https://r2-test/') && method === 'PUT') {
      state.r2PutCalls.push({ url, init: reqInit });
      if (opts?.r2PutBehavior) {
        return opts.r2PutBehavior(url);
      }
      return new Response(null, { status: 200 });
    }

    if (url.endsWith('/deploy') && method === 'POST') {
      state.finalizeCalls.push({ url, init: reqInit });
      return ndjsonResponse(opts?.finalizeEvents ?? defaultDoneEvents());
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  return state;
}

function defaultDoneEvents(): Array<unknown> {
  return [
    { event: 'start', deploymentId: 'dep_test' },
    { event: 'asset_upload', total: 4, new: 4, cached: 0 },
    {
      event: 'done',
      deployment: 'dep_test',
      url: 'https://test.void.app',
      urls: ['https://test.void.app'],
      assets: 4,
      workers: 0,
    },
  ];
}

function ndjsonResponse(events: Array<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson', 'x-void-deployment-id': 'dep_test' },
  });
}

function hexToBase64(hex: string): string {
  const buf = Buffer.from(hex, 'hex');
  return buf.toString('base64');
}

function makeClient(): InstanceType<typeof PlatformClient> {
  return new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog: openTestLog() });
}

let capturedLogPath: string | null = null;
function openTestLog(): ReturnType<typeof openDeployLog> {
  const log = openDeployLog();
  capturedLogPath = log.path;
  return log;
}

function deploy(
  options: {
    client?: InstanceType<typeof PlatformClient>;
    appType?: 'spa' | 'static';
    routing?: Parameters<typeof runStaticDeploy>[10];
    cliLog?: Parameters<typeof runStaticDeploy>[11];
    notFound?: Parameters<typeof runStaticDeploy>[12];
  } = {},
): Promise<void> {
  return runStaticDeploy(
    workdir,
    { projectId: 'proj_t', slug: 'test' },
    options.client ?? makeClient(),
    { buildCommand: null, outputDir: assetsDir, appType: options.appType ?? 'spa' },
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.routing,
    options.cliLog,
    options.notFound,
  );
}

describe('direct-to-R2 deploy flow', () => {
  it.each([true, undefined, false])(
    'prints a single success after the box only when routing is published (%s)',
    async (published) => {
      const { note, outro } = await import('@voidzero-dev/vite-plus-prompts');
      const summary = vi.mocked(note).mockClear();
      const ending = vi.mocked(outro).mockClear();
      const events = defaultDoneEvents() as Array<Record<string, unknown>>;
      events.at(-1)!.published = published;
      installPlatformMocks({ finalizeEvents: events });

      await deploy();

      expect(summary).toHaveBeenCalledOnce();
      if (published === false) {
        expect(ending).not.toHaveBeenCalled();
      } else {
        expect(ending).toHaveBeenCalledOnce();
        expect(ending.mock.calls[0][0]).toContain('✓ Successfully deployed!');
        expect(ending.mock.invocationCallOrder[0]).toBeGreaterThan(
          summary.mock.invocationCallOrder[0],
        );
      }
    },
  );

  it('uploads assets directly to R2 then calls finalize JSON endpoint', async () => {
    const state = installPlatformMocks();

    await deploy();

    expect(state.preflightCalls).toHaveLength(1);
    expect(state.uploadUrlsCalls).toHaveLength(1);
    expect(state.r2PutCalls).toHaveLength(4);
    expect(state.finalizeCalls).toHaveLength(1);

    for (const { init } of state.r2PutCalls) {
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Md5']).toBeDefined();
      expect(headers['Content-Type']).toBeDefined();
      expect(init.method).toBe('PUT');
      expect(init.body).toBeInstanceOf(Uint8Array);
    }

    const finalize = state.finalizeCalls[0];
    expect((finalize.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    const finalizeBody = JSON.parse(finalize.init.body as string);
    expect(finalizeBody.manifest.assetManifestVersion).toBe(2);
    expect(finalizeBody.assetManifest['/index.html']).toMatchObject({
      blake3: expect.any(String),
      md5: expect.any(String),
      size: fixtureFiles['/index.html'].length,
    });
    expect(finalizeBody.preflight).toBe(null);
    expect(finalizeBody.workerFiles).toBeUndefined();
  });

  it('reads each asset file from disk EXACTLY ONCE end-to-end', async () => {
    installPlatformMocks();

    await deploy();

    // Other files, such as config, are read through the same mock.
    const reads = readFileSyncMock.mock.calls.filter(([p]: Array<unknown>) => {
      const path = String(p);
      return (
        path.endsWith('index.html') ||
        path.endsWith('style.css') ||
        path.endsWith('script.js') ||
        path.endsWith('large.bin')
      );
    });

    expect(reads).toHaveLength(4);
    const uniquePaths = new Set(reads.map(([p]: Array<unknown>) => String(p)));
    expect(uniquePaths.size).toBe(4);
  });

  it('prunes the in-memory assetFiles cache to needed-only after preflight', async () => {
    installPlatformMocks({
      preflightNeeded: ['/index.html'],
      preflightSkipped: 3,
    });
    const cliLog = openDeployLog();
    const logPath = cliLog.path;
    expect(logPath).toBeTruthy();
    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await deploy({ client, cliLog });

    await cliLog.close();
    const lines = readFileSync(logPath as string, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { msg: string; before?: number; after?: number });
    const prune = lines.find((l) => l.msg === 'asset_cache_pruned');
    expect(prune).toBeDefined();
    expect(prune?.before).toBe(4);
    expect(prune?.after).toBe(1);
  });

  it('does not log asset_cache_pruned when nothing was skipped', async () => {
    installPlatformMocks();
    const cliLog = openDeployLog();
    const logPath = cliLog.path;
    expect(logPath).toBeTruthy();
    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await deploy({ client, cliLog });

    await cliLog.close();
    const lines = readFileSync(logPath as string, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { msg: string });
    expect(lines.find((l) => l.msg === 'asset_cache_pruned')).toBeUndefined();
  });

  it('skips upload-urls + R2 PUT phase when no assets are needed', async () => {
    const state = installPlatformMocks({ preflightNeeded: [], preflightSkipped: 4 });

    await deploy();

    expect(state.uploadUrlsCalls).toHaveLength(0);
    expect(state.r2PutCalls).toHaveLength(0);
    expect(state.finalizeCalls).toHaveLength(1);
    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.preflight).toBe('true');
  });

  it.each(['static', 'spa'] as const)(
    'includes file-based routing without a routing config (%s)',
    async (appType) => {
      writeFileSync(join(assetsDir, '_headers'), '/about\n  X-Test: file-rule\n');
      writeFileSync(join(assetsDir, '_redirects'), '/old /about 302\n/rewrite /about 200\n');
      const state = installPlatformMocks();

      await deploy({ appType });

      const body = JSON.parse(state.finalizeCalls[0].init.body as string);
      expect(body.manifest.headerRules).toEqual([
        { pattern: '/about', headers: [['X-Test', 'file-rule']] },
      ]);
      expect(body.manifest.redirectRules).toEqual([
        { source: '/old', destination: '/about', status: 302 },
      ]);
      expect(body.manifest.fallbackRules).toContainEqual({
        source: '/rewrite',
        destination: '/about',
        status: 200,
      });
    },
  );

  it('preserves routing rules already merged by the full-to-static path', async () => {
    writeFileSync(join(assetsDir, '_headers'), '/about\n  X-Test: file-rule\n');
    const headerRules = [
      { pattern: '/about', headers: [['X-Test', 'config-rule']] as Array<[string, string]> },
    ];
    const state = installPlatformMocks();

    await runStaticDeploy(
      workdir,
      { projectId: 'proj_t', slug: 'test' },
      makeClient(),
      { buildCommand: null, outputDir: assetsDir, appType: 'static' },
      true,
      undefined,
      undefined,
      headerRules,
    );

    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.manifest.headerRules).toEqual(headerRules);
  });

  // A plain Vite MPA is detected as `spa`, so its notFound must reach the static manifest.
  it('threads routing.notFound into the finalize manifest (static path)', async () => {
    const state = installPlatformMocks();

    await deploy({ routing: { notFound: '404-page' } });

    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.manifest.type).toBe('spa');
    expect(body.manifest.assetConfig).toEqual({ not_found_handling: '404-page' });
    // Overriding away from SPA must NOT leave the synthetic `/* -> /index.html`
    // fallback behind, or the shell would still be served via a rule.
    expect(body.manifest.fallbackRules).toBeUndefined();
  });

  // Calling convention of the "all pages prerendered -> static" redirect in
  // `runFullDeploy`: it merged the routing RULES upstream and deliberately
  // passes `routing: undefined`, so the notFound override has to ride the
  // dedicated trailing param or it is silently dropped there too.
  it('honors an explicit notFound when routing is undefined (full->static redirect shape)', async () => {
    const state = installPlatformMocks();

    await deploy({ appType: 'static', notFound: 'single-page-application' });

    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.manifest.assetConfig).toEqual({
      not_found_handling: 'single-page-application',
    });
  });

  it('surfaces 4xx R2 PUT errors with asset path and hash', async () => {
    installPlatformMocks({
      r2PutBehavior() {
        return new Response('SignatureMismatch', { status: 403 });
      },
    });

    await expect(deploy()).rejects.toThrow(/R2 PUT failed.+SignatureMismatch/);
  });

  it('writes presign + r2_put + finalize events to the JSONL log', async () => {
    installPlatformMocks();
    const cliLog = openDeployLog();
    capturedLogPath = cliLog.path;
    expect(capturedLogPath).toBeTruthy();

    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await deploy({ client, cliLog });

    await cliLog.close();
    const lines = readFileSync(capturedLogPath as string, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { msg: string });
    const events = lines.map((l) => l.msg);
    expect(events).toContain('presign_request_start');
    expect(events).toContain('presign_request_end');
    expect(events).toContain('r2_put_start');
    expect(events).toContain('r2_put_end');
    expect(events).toContain('finalize_start');
    expect(events).toContain('finalize_end');
  });

  it('dedupes presign + R2 PUT by content hash when paths share blake3', async () => {
    const sharedHtml = '<!doctype html><html><body>shared</body></html>\n';
    const dupeRel = '/about.html';
    const dupeRel2 = '/contact.html';
    writeFileSync(join(assetsDir, dupeRel.slice(1)), sharedHtml);
    writeFileSync(join(assetsDir, dupeRel2.slice(1)), sharedHtml);

    const allPaths = [...Object.keys(fixtureFiles), dupeRel, dupeRel2];
    const state = installPlatformMocks({ preflightNeeded: allPaths });

    await deploy();

    expect(state.uploadUrlsCalls).toHaveLength(1);
    const presign = state.uploadUrlsCalls[0] as {
      assets: Array<{ blake3: string }>;
    };
    expect(presign.assets).toHaveLength(5);
    const presignHashes = new Set(presign.assets.map((a) => a.blake3));
    expect(presignHashes.size).toBe(5);

    expect(state.r2PutCalls).toHaveLength(5);
    const r2Hashes = new Set(state.r2PutCalls.map(({ url }) => url.split('/').pop()));
    expect(r2Hashes.size).toBe(5);

    expect(state.finalizeCalls).toHaveLength(1);
    const finalizeBody = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(finalizeBody.assetManifest[dupeRel]).toBeDefined();
    expect(finalizeBody.assetManifest[dupeRel2]).toBeDefined();
    expect(finalizeBody.assetManifest[dupeRel].blake3).toBe(
      finalizeBody.assetManifest[dupeRel2].blake3,
    );
  });

  it('failure-mode error message ends with the JSONL log path', async () => {
    installPlatformMocks({
      finalizeEvents: [{ event: 'error', message: 'something broke', step: 'finalize' }],
    });
    const cliLog = openDeployLog();
    const logPath = cliLog.path;
    expect(logPath).toBeTruthy();

    const client = new PlatformClient('test-token', { apiUrl: 'https://api.test', cliLog });

    await expect(deploy({ client, cliLog })).rejects.toThrow(
      new RegExp(escapeRegex(logPath as string)),
    );

    await cliLog.close();
  });
});

describe('Worker module uploads', () => {
  // Discovery is cached per origin, so each origin is only probed with one answer.
  const directOrigin = 'https://api-direct.test';
  const workerManifest: DeployManifest = {
    version: 3,
    assetManifestVersion: 2,
    bindings: {},
    type: 'void',
    ssr: true,
    workerMain: 'index.js',
  };

  function workerFiles(): Map<string, Buffer> {
    return new Map([
      ['index.js', Buffer.from('export default { fetch() {} };\n')],
      ['chunks/large.js', Buffer.alloc(150_000, 0x61)],
    ]);
  }

  function expectedModules(): Array<WorkerModule> {
    return Array.from(workerFiles(), ([name, bytes]) => ({
      name,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }));
  }

  function advertiseDirectWorkerUpload(): void {
    globalThis.fetch = withPlatformDiscovery(fetchMock, undefined, { directWorkerUpload: true });
  }

  async function deployWorker(
    origin: string,
    files: Map<string, Buffer>,
    needed: Array<string> = [],
  ): Promise<void> {
    const { assetManifest, assetFiles } = await collectAndHashAssets(assetsDir);
    await streamDirectR2Deploy({
      client: new PlatformClient('test-token', { apiUrl: origin }),
      projectId: 'proj_t',
      manifest: workerManifest,
      assetManifest,
      assetFiles,
      needed,
      preflightUsed: false,
      workerFiles: files,
      spinner: noopSpinner as unknown as SpinnerResult,
    });
  }

  it('uploads modules to R2 before the assets and finalizes with workerInput', async () => {
    advertiseDirectWorkerUpload();
    const state = installPlatformMocks();
    const files = workerFiles();

    await deployWorker(directOrigin, files, ['/index.html']);

    const modules = expectedModules();
    expect(state.workerUploadUrlsCalls).toEqual([{ modules }]);
    const workerPuts = state.r2PutCalls.filter(({ url }) => url.includes('/worker/'));
    expect(workerPuts.map(({ url }) => url).sort()).toEqual([
      'https://r2-test/worker/0',
      'https://r2-test/worker/1',
    ]);
    const bytes = [...workerFiles().values()];
    for (const { url, init } of workerPuts) {
      const index = Number(url.split('/').pop());
      expect(init.headers).toEqual(workerPutHeaders(modules[index]));
      expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes[index]);
    }

    // A Worker the platform refuses must fail before any asset upload.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const assetPresign = urls.indexOf(`${directOrigin}/projects/proj_t/deploy/upload-urls`);
    expect(urls.indexOf(`${directOrigin}/projects/proj_t/deploy/worker-upload-urls`)).toBe(0);
    expect(assetPresign).toBeGreaterThan(0);
    expect(urls.slice(assetPresign).filter((url) => url.includes('/worker/'))).toEqual([]);
    expect(state.uploadUrlsCalls).toHaveLength(1);

    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body.workerInput).toEqual({ id: 'wup_test', modules });
    expect(body).not.toHaveProperty('workerFiles');
    // Each buffer is released once R2 has it.
    expect(files.size).toBe(0);
  });

  it('keeps sending modules inline when discovery does not advertise direct uploads', async () => {
    const state = installPlatformMocks();

    await deployWorker('https://api-inline.test', workerFiles());

    expect(state.workerUploadUrlsCalls).toHaveLength(0);
    expect(state.r2PutCalls).toHaveLength(0);
    const body = JSON.parse(state.finalizeCalls[0].init.body as string);
    expect(body).not.toHaveProperty('workerInput');
    expect(body.workerFiles).toEqual(
      Object.fromEntries(
        Array.from(workerFiles(), ([name, bytes]) => [name, bytes.toString('base64')]),
      ),
    );
  });

  it('uploads nothing when the platform refuses the Worker size', async () => {
    advertiseDirectWorkerUpload();
    const message = 'This Worker is 70 MB without source maps. Cloudflare allows at most 64 MiB.';
    const state = installPlatformMocks({
      workerUploadUrls: () =>
        Response.json({ error: 'worker_too_large', message }, { status: 413 }),
    });

    await expect(
      deployWorker(directOrigin, workerFiles(), Object.keys(fixtureFiles)),
    ).rejects.toThrow(message);

    expect(state.workerUploadUrlsCalls).toHaveLength(1);
    expect(state.uploadUrlsCalls).toHaveLength(0);
    expect(state.r2PutCalls).toHaveLength(0);
    expect(state.finalizeCalls).toHaveLength(0);
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import type { ProjectRole } from '../../src/cli/client.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import type { DetectedFramework } from '../../src/plugin-inference.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

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
vi.mock('../../src/cli/output.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/cli/output.ts')>('../../src/cli/output.ts');
  return { ...actual, createSpinner: () => noopSpinner };
});

// Prerender discovery starts workerd and feeds only `manifest.prerender`; stub it to stay offline.
const { mockCollectPrerenderPaths } = vi.hoisted(() => ({
  mockCollectPrerenderPaths: vi.fn(async () => [] as Array<string>),
}));
vi.mock('../../src/prerender.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/prerender.ts')>('../../src/prerender.ts');
  return {
    ...actual,
    collectPrerenderPaths: mockCollectPrerenderPaths,
  };
});

// Lets one pre-built fixture take both the Void pages and the framework deploy paths.
const { mockDetectFramework } = vi.hoisted(() => ({
  mockDetectFramework: vi.fn<(root: string) => DetectedFramework | undefined>(),
}));
vi.mock('../../src/plugin-inference.ts', async () => {
  const actual = await vi.importActual<typeof import('../../src/plugin-inference.ts')>(
    '../../src/plugin-inference.ts',
  );
  return { ...actual, detectFramework: mockDetectFramework };
});

const { runDeploy } = await import('../../src/cli/deploy.ts');

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/named-layouts';
let playground: IsolatedPlayground;
let fixture = '';
let projectJson = '';

const fetchMock = vi.fn();
let originalFetch: typeof globalThis.fetch | undefined;
let savedToken: string | undefined;
let savedProject: string | undefined;

type Captured = {
  finalizeBody: {
    manifest?: {
      pages?: unknown;
      alwaysUseHttps?: boolean;
      bindings?: Record<string, unknown>;
      vars?: Record<string, string>;
    };
  } | null;
};

// Every asset is reported as present, so the deploy skips uploads and goes straight to finalize.
function installPlatformMocks(role: ProjectRole = 'owner'): Captured {
  const captured: Captured = { finalizeBody: null };

  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const reqInit = init ?? {};
    const method = (reqInit.method ?? 'GET').toUpperCase();

    if (url.endsWith('/projects/resolve?slug=named-layouts-test') && method === 'GET') {
      return json({ project: null });
    }
    if (
      (url.endsWith('/projects/proj_named_layouts_test') && method === 'GET') ||
      (url.endsWith('/projects') && method === 'POST')
    ) {
      return json({
        id: 'proj_named_layouts_test',
        user_id: 'user_owner',
        slug: 'named-layouts-test',
        type: 'worker',
        created_at: '2026-09-01T00:00:00.000Z',
        custom_domain: null,
        role,
        owner: { id: 'user_owner', login: 'owner' },
      });
    }

    if (url.endsWith('/deploy/preflight') && method === 'POST') {
      const body = JSON.parse(reqInit.body as string) as {
        assetManifest?: Record<string, unknown>;
      };
      const total = Object.keys(body.assetManifest ?? {}).length;
      return json({ needed: [], total, skipped: total });
    }

    if (url.endsWith('/projects/proj_named_layouts_test/prerender-token') && method === 'POST') {
      return json({ token: 'scoped-prerender-token' });
    }

    if (url.endsWith('/deploy') && method === 'POST') {
      captured.finalizeBody = JSON.parse(reqInit.body as string);
      return ndjson([
        { event: 'start', deploymentId: 'dep_test' },
        {
          event: 'done',
          deployment: 'dep_test',
          url: 'https://named-layouts.test.void.app',
          urls: ['https://named-layouts.test.void.app'],
          assets: 0,
          workers: 1,
        },
      ]);
    }

    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });

  return captured;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjson(events: Array<unknown>): Response {
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

describe('managed deployment manifests (built Worker)', () => {
  beforeAll(() => {
    playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
    fixture = playground.root;
    projectJson = join(fixture, '.void', 'project.json');

    const result = spawn.sync('vp', ['build'], {
      cwd: fixture,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, VOID_TOKEN: 'test-token-do-not-use' },
    });
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);

    mkdirSync(join(fixture, '.void'), { recursive: true });
    writeFileSync(
      projectJson,
      JSON.stringify({
        projectId: 'proj_named_layouts_test',
        slug: 'named-layouts-test',
        platformUrl: 'https://platform.example.test',
      }),
    );
  }, 180_000);

  afterAll(() => {
    playground?.cleanup();
  });

  beforeEach(() => {
    mockDetectFramework.mockReset().mockReturnValue(undefined);

    originalFetch = globalThis.fetch;
    globalThis.fetch = withPlatformDiscovery(fetchMock);
    fetchMock.mockReset();
    mockCollectPrerenderPaths.mockClear();

    savedToken = process.env.VOID_TOKEN;
    savedProject = process.env.VOID_PROJECT;
    // Explicit token bypasses getToken() + the GitHub-Actions OIDC branch.
    process.env.VOID_TOKEN = 'test-token-do-not-use';
    vi.stubEnv('VOID_API_URL', 'https://platform.example.test');
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(fixture, 'registry'));
    savePlatformConnection({
      accountId: null,
      apiUrl: 'https://platform.example.test',
      applicationDomain: 'apps.example.test',
      displayName: 'Test platform',
      installationId: null,
      kind: 'connected',
      proxyUrl: 'https://proxy.example.test',
    });
    // Select the saved project; runDeploy verifies its current role through the API.
    delete process.env.VOID_PROJECT;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    if (savedToken === undefined) {
      delete process.env.VOID_TOKEN;
    } else {
      process.env.VOID_TOKEN = savedToken;
    }
    if (savedProject === undefined) {
      delete process.env.VOID_PROJECT;
    } else {
      process.env.VOID_PROJECT = savedProject;
    }
  });

  it('forwards the page scan into the finalize manifest.pages (incl. the ISR page)', async () => {
    const captured = installPlatformMocks();

    await runDeploy(fixture, { skipBuild: true });

    expect(mockCollectPrerenderPaths).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj_named_layouts_test',
        voidToken: 'scoped-prerender-token',
      }),
    );

    expect(captured.finalizeBody).not.toBeNull();
    const pages = captured.finalizeBody!.manifest?.pages as
      | Array<{ pattern: string; revalidate?: number }>
      | undefined;

    expect(pages).toContainEqual({ pattern: '/isr', revalidate: 60 });

    // The fixture's object `routing.revalidate` ships as `pathRevalidate`; pages without their own
    // export carry no `revalidate`, so dispatch resolves it per request path.
    const manifest = captured.finalizeBody!.manifest as unknown as {
      pathRevalidate?: Record<string, number>;
    };
    expect(manifest.pathRevalidate).toEqual({ '/docs': 120, '/docs/ref': 0 });
    expect(pages).toContainEqual({ pattern: '/docs' });
    expect(pages).toContainEqual({ pattern: '/docs/ref' });
    const docsEntry = pages!.find((p) => p.pattern === '/docs');
    const docsRefEntry = pages!.find((p) => p.pattern === '/docs/ref');
    expect(docsEntry).not.toHaveProperty('revalidate');
    expect(docsRefEntry).not.toHaveProperty('revalidate');
  });

  it('suppresses manifest.pages in framework mode (Class-A framework forced via detectFramework)', async () => {
    // The vinext-pages preset uses the same dist layout as this Void build.
    mockDetectFramework.mockReturnValue({ name: 'vinext-pages', class: 'a' });
    const captured = installPlatformMocks();

    await runDeploy(fixture, { skipBuild: true });

    expect(captured.finalizeBody).not.toBeNull();
    expect(captured.finalizeBody!.manifest).toBeDefined();
    expect(captured.finalizeBody!.manifest?.pages).toBeUndefined();
  });

  it('sends custom inference.bindings names in the manifest bindings', async () => {
    const configPath = join(fixture, 'void.config.ts');
    const original = readFileSync(configPath, 'utf8');
    writeFileSync(
      configPath,
      original.replace(
        'export default defineConfig({',
        "export default defineConfig({\n  inference: { bindings: { kv: 'MY_KV', storage: 'MY_BUCKET' } },",
      ),
    );
    try {
      const captured = installPlatformMocks();

      await runDeploy(fixture, { skipBuild: true });

      expect(captured.finalizeBody?.manifest?.bindings).toMatchObject({
        kv: ['MY_KV'],
        r2: ['MY_BUCKET'],
      });
    } finally {
      writeFileSync(configPath, original);
    }
  });

  it.each([
    ['Void', undefined],
    ['Class A', { name: 'vinext-pages', class: 'a' }],
    ['Class C', { name: 'astro', class: 'c' }],
  ] as const)(
    'includes configured worker.vars and HTTPS policy in the %s deployment request',
    async (_, detected) => {
      mockDetectFramework.mockReturnValue(detected);
      const configPath = join(fixture, 'void.config.ts');
      const original = readFileSync(configPath, 'utf8');
      const dotenvPath = join(fixture, '.env');
      const originalDotenv = existsSync(dotenvPath) ? readFileSync(dotenvPath) : undefined;
      const alwaysUseHttps = detected?.class !== 'a';
      const vars = { API_URL: 'https://api.example.test', EMPTY_SETTING: '' };
      writeFileSync(
        configPath,
        original
          .replace('worker: {', `worker: { vars: ${JSON.stringify(vars)},`)
          .replace('routing: {', `routing: { alwaysUseHttps: ${alwaysUseHttps},`),
      );
      writeFileSync(dotenvPath, 'API_URL=https://local.example.test\nADMIN_TOKEN=local-secret\n');
      if (detected?.name === 'astro') {
        // Reuse the built Worker at the Class C preset's output paths.
        cpSync(join(fixture, 'dist/ssr'), join(fixture, 'dist/server'), { recursive: true });
        copyFileSync(join(fixture, 'dist/server/index.js'), join(fixture, 'dist/server/entry.mjs'));
      }
      try {
        const captured = installPlatformMocks();
        await runDeploy(fixture, { skipBuild: true });
        expect(captured.finalizeBody?.manifest?.vars).toEqual(vars);
        expect(captured.finalizeBody?.manifest?.alwaysUseHttps).toBe(alwaysUseHttps);
      } finally {
        writeFileSync(configPath, original);
        if (originalDotenv === undefined) {
          rmSync(dotenvPath, { force: true });
        } else {
          writeFileSync(dotenvPath, originalDotenv);
        }
      }
    },
  );

  it('uses the alternate project for Worker packaging and prerendering while retaining the saved link', async () => {
    const original = readFileSync(projectJson, 'utf8');
    const saved = JSON.stringify({
      projectId: 'project-on-original-platform',
      slug: 'named-layouts-test',
      platformUrl: 'https://original.example.test',
      platform: 'void',
    });
    writeFileSync(projectJson, saved);
    try {
      const captured = installPlatformMocks();
      await runDeploy(fixture, { projectSlug: 'named-layouts-test', skipBuild: true });
      expect(readFileSync(projectJson, 'utf8')).toBe(saved);
      expect(mockCollectPrerenderPaths).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj_named_layouts_test',
          voidToken: 'scoped-prerender-token',
        }),
      );
      expect(captured.finalizeBody?.manifest?.pages).toBeDefined();
      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls.every((url) => url.startsWith('https://platform.example.test/'))).toBe(true);
      expect(urls.some((url) => url.includes('project-on-original-platform'))).toBe(false);
      expect(urls).toContain(
        'https://platform.example.test/projects/proj_named_layouts_test/deploy',
      );
    } finally {
      writeFileSync(projectJson, original);
    }
  });

  it('rejects a saved reader project before building or uploading', async () => {
    const captured = installPlatformMocks('reader');

    // Do not skip the build: access must be checked before framework detection
    // can select a build path, regardless of the fixture's existing artifacts.
    await expect(runDeploy(fixture)).rejects.toThrow(
      'You have reader access to "named-layouts-test" and cannot deploy.',
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/projects\/proj_named_layouts_test$/);
    expect(mockDetectFramework).not.toHaveBeenCalled();
    expect(mockCollectPrerenderPaths).not.toHaveBeenCalled();
    expect(captured.finalizeBody).toBeNull();
  });
});

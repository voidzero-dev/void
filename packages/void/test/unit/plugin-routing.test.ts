import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createServer,
  normalizePath,
  type ConfigEnv,
  type ResolvedConfig,
  type RunnableDevEnvironment,
  type UserConfig,
} from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import { GENERATED_ASSET_HEADERS_MARKER } from '../../src/asset-worker-bypass.ts';
import * as authConfig from '../../src/auth/config.ts';
import { readConfig } from '../../src/config.ts';
import { routingPlugin } from '../../src/plugin-routing.ts';
import { readProjectPaths } from '../../src/project-paths.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-routing-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'routes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function createBareTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-routing-'));
  tempDirs.push(root);
  return root;
}

type RoutingPlugin = ReturnType<typeof routingPlugin>;

function createRoutingPlugin(
  root: string,
  options: Omit<Parameters<typeof routingPlugin>[1], 'getApplicationAnalysis'>,
): RoutingPlugin {
  return routingPlugin(root, {
    ...options,
    getApplicationAnalysis: (environment) =>
      analyzeApplicationSync(root, { config: readConfig(root), environment }),
  });
}

function runConfig(plugin: RoutingPlugin, env: ConfigEnv): void {
  (getHookHandler(plugin.config) as (config: UserConfig, env: ConfigEnv) => unknown)({}, env);
}

function resolveConfig(
  plugin: RoutingPlugin,
  command: 'build' | 'serve',
  plugins: Array<{ name: string }> = [],
): void {
  (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
    build: { assetsDir: 'assets' },
    command,
    mode: command === 'build' ? 'production' : 'development',
    plugins,
  } as unknown as ResolvedConfig);
}

async function runBuildStart(plugin: RoutingPlugin): Promise<void> {
  await (getHookHandler(plugin.buildStart) as () => Promise<void>).call({} as never);
}

function fakeDevServer(
  moduleIds: Array<string> = [],
  extraEnvironments: Record<string, unknown> = {},
) {
  const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
  const invalidated: Array<string> = [];
  const restart = vi.fn(async () => {});
  const logError = vi.fn();
  const modules = new Map(moduleIds.map((id) => [id, { id }]));
  const server = {
    config: { logger: { error: logError } },
    watcher: {
      on(event: string, handler: (path: string) => Promise<void> | void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    environments: {
      ...extraEnvironments,
      void_worker: {
        moduleGraph: {
          getModuleById(id: string) {
            return modules.get(id);
          },
          invalidateModule(mod: { id: string }) {
            invalidated.push(mod.id);
          },
        },
        hot: { send() {} },
      },
    },
    restart,
  };
  async function emit(event: string, path: string): Promise<void> {
    for (const handler of handlers.get(event) ?? []) {
      await handler(path);
    }
  }
  return { server, invalidated, restart, emit, logError };
}

function startDevServer(
  plugin: RoutingPlugin,
  moduleIds?: Array<string>,
  extraEnvironments?: Record<string, unknown>,
) {
  const dev = fakeDevServer(moduleIds, extraEnvironments);
  (getHookHandler(plugin.configureServer) as (server: unknown) => void)(dev.server);
  return dev;
}

const PAGE_MODULE_IDS = [
  '\0virtual:void-pages-renderer',
  '\0virtual:void-pages-client',
  'virtual:void-routes',
];

describe('routingPlugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables the worker SPA fallback for websocket-only routes', async () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'routes', 'notifications.ws.ts'),
      'export default defineWebSocket({});\n',
    );

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    resolveConfig(plugin, 'build');
    await runBuildStart(plugin);

    const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
    expect(entry).toContain('app, assets: serveWithAssets');
    expect(entry).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":true,"notFound":"none"});',
    );
  });

  it('does not enable the worker SPA fallback for auth-only apps', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ auth: { providers: ['email'] } }));

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => true });
    resolveConfig(plugin, 'build');
    await runBuildStart(plugin);

    const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
    expect(entry).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":false,"notFound":"single-page-application"});',
    );
  });

  it('resolves extensionless and Vite alias imports in auth.ts during a build', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'lib'));
    mkdirSync(join(root, 'fields'));
    writeFileSync(
      join(root, 'auth.ts'),
      [
        "import type { VoidAuthConfig } from 'void/auth';",
        "import { nickname } from './lib/nickname';",
        "import { pronouns } from '@fields/pronouns';",
        'export default { user: { additionalFields: { nickname, pronouns } } } satisfies VoidAuthConfig;',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'lib', 'nickname.ts'),
      "export const nickname = { type: 'string', required: false } as const;",
    );
    writeFileSync(
      join(root, 'fields', 'pronouns.ts'),
      "export const pronouns = { type: 'string', required: false } as const;",
    );

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => true });
    (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
      build: { assetsDir: 'assets' },
      command: 'build',
      mode: 'production',
      plugins: [],
      root,
      resolve: { alias: [{ find: '@fields', replacement: join(root, 'fields') }] },
    } as unknown as ResolvedConfig);
    await runBuildStart(plugin);

    const schema = readFileSync(join(root, '.void', 'better-auth-schema.ts'), 'utf8');
    expect(schema).toContain('nickname');
    expect(schema).toContain('pronouns');
  });

  it('bakes explicit page opt-outs into the native ISR policy', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages', 'private.tsx'), 'export default function Page() {}\n');
    writeFileSync(join(root, 'pages', 'private.server.ts'), 'export const revalidate = 0;\n');
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ routing: { revalidate: { '/private': 60 } } }),
    );

    const savedProjectId = process.env.VOID_DEPLOY_PROJECT_ID;
    delete process.env.VOID_DEPLOY_PROJECT_ID;
    try {
      const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
      const load = getHookHandler(plugin.load) as (id: string) => Promise<string | undefined>;

      runConfig(plugin, { command: 'build', mode: 'production' });
      resolveConfig(plugin, 'build');
      await runBuildStart(plugin);
      const routes = await load('virtual:void-routes');

      expect(routes).toContain(
        'export const __VOID_ISR_PAGES = [{"pattern":"/private","revalidate":0}];',
      );
      expect(routes).toContain('export const __VOID_ISR_PATH_REVALIDATE = {"/private":60};');
    } finally {
      if (savedProjectId === undefined) {
        delete process.env.VOID_DEPLOY_PROJECT_ID;
      } else {
        process.env.VOID_DEPLOY_PROJECT_ID = savedProjectId;
      }
    }
  });

  it('resolves explicit framework client subpaths to framework auth clients', async () => {
    const root = createBareTempRoot();
    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment?: { name?: string } },
      id: string,
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (id: string) => Promise<string | undefined>;

    resolveConfig(plugin, 'serve');

    expect(resolveId.call({ environment: { name: 'client' } }, 'void/client/react')).toBe(
      'virtual:void-client-browser:react',
    );
    expect(resolveId.call({ environment: { name: 'void_worker' } }, 'void/client/react')).toBe(
      'virtual:void-client-worker:react',
    );

    const browserCode = await load('virtual:void-client-browser:react');
    expect(browserCode).toContain('auth-client-react.mjs');
    expect(browserCode).not.toContain('cloudflare:workers');

    const workerCode = await load('virtual:void-client-worker:react');
    expect(workerCode).toContain('auth-client-react.mjs');
    expect(workerCode).toContain('cloudflare:workers');
  });

  it('refuses to load the route table in the client environment', async () => {
    const plugin = createRoutingPlugin(createBareTempRoot(), {
      isAuthEnabled: () => false,
      devTriggerToken: 'secret-dev-token',
    });
    const load = getHookHandler(plugin.load) as (
      this: { environment?: { name?: string } },
      id: string,
    ) => Promise<string | undefined>;

    runConfig(plugin, { command: 'serve', mode: 'development' });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);

    await expect(
      load.call({ environment: { name: 'client' } }, 'virtual:void-routes'),
    ).rejects.toThrow('server-only');
    await expect(
      load.call({ environment: { name: 'void_worker' } }, 'virtual:void-routes'),
    ).resolves.toContain('secret-dev-token');
  });

  it.each([
    {
      change: 'a structural route change',
      initialRoute: 'api.ts',
      addedRoute: 'dashboard.ts',
      policy: {
        assetConfig: expect.objectContaining({ not_found_handling: 'none' }),
        workerFirst: true,
      },
    },
    {
      change: 'adding the first API route',
      initialRoute: undefined,
      addedRoute: 'api.ts',
      policy: {
        apiWorkerFirst: true,
        assetConfig: expect.objectContaining({
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api', '/api/*', '/__void', '/__void/*'],
        }),
        workerFirst: false,
      },
    },
  ])(
    'restarts dev when $change changes the asset routing policy',
    async ({ initialRoute, addedRoute, policy }) => {
      const root = createTempRoot();
      const routeSource = 'export const GET = () => new Response();\n';
      if (initialRoute) {
        writeFileSync(join(root, 'routes', initialRoute), routeSource);
      }

      const onPolicyChange = vi.fn(() => true);
      const plugin = createRoutingPlugin(root, {
        isAuthEnabled: () => false,
        onDevAssetRoutingPolicyChange: onPolicyChange,
      });
      resolveConfig(plugin, 'serve');
      await runBuildStart(plugin);
      const { emit, restart } = startDevServer(plugin);
      restart.mockImplementation(() => runBuildStart(plugin));

      const addedPath = join(root, 'routes', addedRoute);
      writeFileSync(addedPath, routeSource);
      await emit('add', addedPath);

      expect(onPolicyChange).toHaveBeenCalledWith(expect.objectContaining(policy));
      expect(restart).toHaveBeenCalledTimes(1);
    },
  );

  it('invalidates page renderer modules before route table reloads for new pages', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'index.tsx'),
      'export default function Index() { return null; }',
    );

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    const { emit, invalidated } = startDevServer(plugin, PAGE_MODULE_IDS);

    writeFileSync(
      join(root, 'pages', 'test.tsx'),
      'export default function Test() { return null; }',
    );
    await emit('add', join(root, 'pages', 'test.tsx'));

    expect(invalidated).toEqual(PAGE_MODULE_IDS);
  });

  it.each([
    ['logs it', [], 1],
    ['leaves the log to the adapter pages plugin', [{ name: 'void-react:pages' }], 0],
  ])(
    'keeps the last route table when a page added in dev clashes, and %s',
    async (_, plugins, logs) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'pages', 'about'), { recursive: true });
      const flatPath = join(root, 'pages', 'about.tsx');
      writeFileSync(flatPath, 'export default function About() { return null; }');

      const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
      resolveConfig(plugin, 'serve', plugins);
      const { emit, invalidated, logError } = startDevServer(plugin, PAGE_MODULE_IDS);

      // Moving about.tsx to about/index.tsx adds the new file before the old one goes.
      const indexPath = join(root, 'pages', 'about', 'index.tsx');
      writeFileSync(indexPath, 'export default function About() { return null; }');
      await emit('add', indexPath);

      expect(logError).toHaveBeenCalledTimes(logs);
      if (logs) {
        expect(logError.mock.calls[0][0]).toContain(
          'pages: Multiple page files resolve to the same route:',
        );
      }
      expect(invalidated).toEqual([]);

      rmSync(flatPath);
      await emit('unlink', flatPath);

      expect(logError).toHaveBeenCalledTimes(logs);
      expect(invalidated).toEqual(PAGE_MODULE_IDS);
    },
  );

  it('ignores a .prod page added next to its .dev page in dev', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    const action = 'export const action = () => ({});';
    writeFileSync(join(root, 'pages', 'home.dev.tsx'), 'export default () => null;');
    writeFileSync(join(root, 'pages', 'home.dev.server.ts'), action);

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    runConfig(plugin, { command: 'serve', mode: 'development' });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    const { emit, logError } = startDevServer(plugin, PAGE_MODULE_IDS);
    const typesPath = join(root, '.void', 'routes.d.ts');
    const before = readFileSync(typesPath, 'utf8');
    expect(before).toContain('pages/home.dev.server.ts');

    writeFileSync(join(root, 'pages', 'home.prod.server.ts'), action);
    const prodPath = join(root, 'pages', 'home.prod.tsx');
    writeFileSync(prodPath, 'export default () => null;');
    await emit('add', prodPath);

    expect(logError).not.toHaveBeenCalled();
    expect(readFileSync(typesPath, 'utf8')).toBe(before);
  });

  it('keeps page and route modules for saves that change no scanned facts', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    const pagePath = join(root, 'pages', 'index.tsx');
    const serverPath = join(root, 'pages', 'index.server.ts');
    const routePath = join(root, 'routes', 'health.ts');
    writeFileSync(pagePath, 'export default function Index() { return null; }');
    writeFileSync(serverPath, 'export const loader = () => ({ count: 1 });');
    writeFileSync(routePath, 'export const GET = () => new Response("ok");');

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    const { emit, invalidated } = startDevServer(plugin, PAGE_MODULE_IDS);

    writeFileSync(pagePath, 'export default function Index() { return <h1>Updated</h1>; }');
    await emit('change', pagePath);

    writeFileSync(serverPath, 'export const loader = () => ({ count: 2 });');
    await emit('change', serverPath);

    writeFileSync(routePath, 'export const GET = () => new Response("still ok");');
    await emit('change', routePath);

    expect(invalidated).toEqual([]);
  });

  it('regenerates the route table when a save changes scanned facts', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    const serverPath = join(root, 'pages', 'index.server.ts');
    const routePath = join(root, 'routes', 'health.ts');
    writeFileSync(
      join(root, 'pages', 'index.tsx'),
      'export default function Index() { return null; }',
    );
    writeFileSync(serverPath, 'export const loader = () => ({});');
    writeFileSync(routePath, 'export const GET = () => new Response("ok");');

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    const { emit, invalidated } = startDevServer(plugin, PAGE_MODULE_IDS);

    writeFileSync(
      serverPath,
      'export const loader = () => ({});\nexport const action = () => ({});',
    );
    await emit('change', serverPath);

    expect(invalidated).toEqual(['virtual:void-routes']);

    writeFileSync(
      routePath,
      'export const GET = () => new Response("ok");\nexport const POST = () => new Response("ok");',
    );
    await emit('change', routePath);

    expect(invalidated).toEqual(['virtual:void-routes', 'virtual:void-routes']);
  });

  it.each([
    { change: 'route exports', failure: 'generated-file write' },
    { change: 'an environment file', failure: 'generated-file write' },
    { change: 'route exports', failure: 'module invalidation' },
    { change: 'an environment file', failure: 'module invalidation' },
    { change: 'route exports', failure: 'auth generation' },
  ])('retries after a failed $failure for $change', async ({ change, failure }) => {
    const root = createTempRoot();
    const routePath = join(root, 'routes', 'health.ts');
    const envPath = readProjectPaths(root).envFileCandidates[0]!;
    const changesExports = change === 'route exports';
    const failsWrite = failure === 'generated-file write';

    writeFileSync(routePath, 'export const GET = () => new Response("ok");');
    writeFileSync(envPath, 'export default {};');

    const plugin = createRoutingPlugin(root, {
      isAuthEnabled: () => failure === 'auth generation',
    });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);

    const typesPath = join(root, '.void', 'routes.d.ts');
    const previousTypes = readFileSync(typesPath, 'utf-8');
    const { server, emit, invalidated, logError } = startDevServer(plugin, ['virtual:void-routes']);

    expect(previousTypes).not.toContain('POST: {');

    if (failsWrite) {
      rmSync(typesPath);
      mkdirSync(typesPath);
    } else if (failure === 'auth generation') {
      vi.spyOn(authConfig, 'loadVoidAuthConfig').mockRejectedValueOnce(
        new Error('Transient auth generation failure'),
      );
    } else {
      vi.spyOn(
        server.environments.void_worker.moduleGraph,
        'invalidateModule',
      ).mockImplementationOnce(() => {
        throw new Error('Transient module invalidation failure');
      });
    }

    const postExport = changesExports ? '\nexport const POST = () => new Response("created");' : '';

    if (changesExports) {
      writeFileSync(routePath, 'export const GET = () => new Response("ok");' + postExport);
    } else {
      writeFileSync(envPath, 'export default { example: true };');
    }

    await expect(emit('change', changesExports ? routePath : envPath)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(invalidated).toEqual([]);

    if (failsWrite) {
      rmSync(typesPath, { recursive: true });
      writeFileSync(typesPath, previousTypes);
    }

    writeFileSync(routePath, 'export const GET = () => new Response("updated");' + postExport);
    await emit('change', routePath);

    expect(invalidated).toEqual(['virtual:void-routes']);
    expect(readFileSync(typesPath, 'utf-8').includes('POST: {')).toBe(changesExports);

    writeFileSync(
      routePath,
      'export const GET = () => new Response("updated again");' + postExport,
    );
    await emit('change', routePath);

    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it('regenerates for an environment file save that leaves the scan unchanged', async () => {
    const root = createTempRoot();
    const routePath = join(root, 'routes', 'health.ts');
    const envPath = readProjectPaths(root).envFileCandidates[0]!;
    writeFileSync(routePath, 'export const GET = () => new Response("ok");');
    writeFileSync(envPath, 'export default {};');

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    const { emit, invalidated } = startDevServer(plugin, ['virtual:void-routes']);

    writeFileSync(envPath, 'export default { example: true };');
    await emit('change', envPath);
    expect(invalidated).toEqual(['virtual:void-routes']);

    // A later body save is back on the fast path.
    writeFileSync(routePath, 'export const GET = () => new Response("updated");');
    await emit('change', routePath);
    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it('regenerates a reverted edit after the update before it failed', async () => {
    const root = createTempRoot();
    const routePath = join(root, 'routes', 'health.ts');
    const get = 'export const GET = () => new Response("ok");';
    writeFileSync(routePath, get);

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    const { server, emit, invalidated, logError } = startDevServer(plugin, ['virtual:void-routes']);
    vi.spyOn(
      server.environments.void_worker.moduleGraph,
      'invalidateModule',
    ).mockImplementationOnce(() => {
      throw new Error('Transient module invalidation failure');
    });

    writeFileSync(routePath, get + '\nexport const POST = () => new Response("created");');
    await emit('change', routePath);
    expect(logError).toHaveBeenCalledTimes(1);

    // Back to the scan of the last good checkpoint: the files written for POST
    // must still be replaced.
    writeFileSync(routePath, get);
    await emit('change', routePath);
    expect(readFileSync(join(root, '.void', 'routes.d.ts'), 'utf8')).not.toContain('POST: {');
    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it('repairs a generated file another process rewrote', async () => {
    const root = createTempRoot();
    const routePath = join(root, 'routes', 'health.ts');
    writeFileSync(routePath, 'export const GET = () => new Response("ok");');

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    const { emit, invalidated } = startDevServer(plugin, ['virtual:void-routes']);
    const typesPath = join(root, '.void', 'routes.d.ts');
    const types = readFileSync(typesPath, 'utf8');

    // For example `void build` in another terminal, which writes production routes.
    writeFileSync(typesPath, '// written by another process\n');
    writeFileSync(routePath, 'export const GET = () => new Response("updated");');
    await emit('change', routePath);

    expect(readFileSync(typesPath, 'utf8')).toBe(types);
    expect(invalidated).toEqual(['virtual:void-routes']);
    await emit('change', routePath);
    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it.each(['startup', 'another save'])('serializes regeneration with %s', async (overlap) => {
    const root = createTempRoot();
    const routePath = join(root, 'routes', 'health.ts');
    const get = 'export const GET = () => new Response();';
    const post = get + '\nexport const POST = () => new Response();';
    const remove = get + '\nexport const DELETE = () => new Response();';
    writeFileSync(routePath, get);

    const getApplicationAnalysis = vi.fn((environment: 'dev' | 'prod') =>
      analyzeApplicationSync(root, { config: readConfig(root), environment }),
    );
    const plugin = routingPlugin(root, { isAuthEnabled: () => true, getApplicationAnalysis });
    resolveConfig(plugin, 'serve');
    const { emit, invalidated } = startDevServer(plugin, ['virtual:void-routes']);
    if (overlap === 'another save') {
      await runBuildStart(plugin);
    }
    getApplicationAnalysis.mockClear();

    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    const pause = new Promise<undefined>((resolve) => {
      resume = () => resolve(undefined);
    });
    vi.spyOn(authConfig, 'loadVoidAuthConfig').mockImplementationOnce(() => {
      started();
      return pause;
    });
    writeFileSync(routePath, post);
    const first = overlap === 'startup' ? runBuildStart(plugin) : emit('change', routePath);
    await entered;
    writeFileSync(routePath, remove);
    const second = emit('change', routePath);
    try {
      // Give the second event every chance to start: a queue that only defers
      // by a microtask would rescan here.
      await new Promise((resolve) => setImmediate(resolve));
      // The second event must not replace the shared scan while the first writer awaits auth.
      expect(getApplicationAnalysis).toHaveBeenCalledTimes(1);
    } finally {
      resume();
      await Promise.all([first, second]);
    }

    const typesPath = join(root, '.void', 'routes.d.ts');
    expect(readFileSync(typesPath, 'utf8')).toContain('DELETE: {');
    invalidated.length = 0;
    writeFileSync(routePath, post);
    await emit('change', routePath);
    expect(readFileSync(typesPath, 'utf8')).toContain('POST: {');
    expect(readFileSync(typesPath, 'utf8')).not.toContain('DELETE: {');
    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it.each([
    {
      change: 'providers',
      config: { auth: { providers: ['google'] } },
      expected: 'providers: ["google"]',
    },
    {
      change: 'database dialect',
      config: { database: 'pg', auth: { providers: ['email'] } },
      expected: 'better-auth-pg.mjs',
    },
  ])('refreshes auth $change on a body save', async ({ config, expected }) => {
    const root = createTempRoot();
    const routePath = join(root, 'routes', 'health.ts');
    const configPath = join(root, 'void.config.ts');
    writeFileSync(
      configPath,
      'export default ' + JSON.stringify({ auth: { providers: ['email'] } }),
    );
    writeFileSync(routePath, 'export const GET = () => new Response();');
    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => true });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    const { emit, invalidated } = startDevServer(plugin, ['virtual:void-routes']);
    writeFileSync(configPath, 'export default ' + JSON.stringify(config));
    writeFileSync(routePath, 'export const GET = () => new Response("updated");');
    await emit('change', routePath);

    const load = getHookHandler(plugin.load) as (id: string) => Promise<string>;
    expect(await load('virtual:void-routes')).toContain(expected);
    expect(invalidated).toEqual(['virtual:void-routes']);
    await emit('change', routePath);
    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it.each([
    { target: undefined, auth: false, files: ['routes.d.ts', 'queues.d.ts', 'entry.ts'] },
    {
      target: 'node' as const,
      auth: false,
      files: ['routes.d.ts', 'queues.d.ts', 'app.ts', 'index.ts'],
    },
    { target: undefined, auth: true, files: ['better-auth-db.ts', 'better-auth-schema.ts'] },
  ])(
    'repairs deleted generated files for target $target with auth $auth',
    async ({ target, auth, files }) => {
      const root = createTempRoot();
      const routePath = join(root, 'routes', 'health.ts');
      writeFileSync(routePath, 'export const GET = () => new Response();');
      const plugin = createRoutingPlugin(root, { target, isAuthEnabled: () => auth });
      resolveConfig(plugin, 'serve');
      await runBuildStart(plugin);
      const { emit, invalidated } = startDevServer(plugin, ['virtual:void-routes']);
      const outputs = files.map((file) => {
        const path = join(root, '.void', file);
        const content = readFileSync(path, 'utf8');
        rmSync(path);
        return { path, content };
      });
      writeFileSync(routePath, 'export const GET = () => new Response("updated");');
      await emit('change', routePath);
      for (const { path, content } of outputs) {
        expect(readFileSync(path, 'utf8')).toBe(content);
      }
      expect(invalidated).toEqual(['virtual:void-routes']);
      await emit('change', routePath);
      expect(invalidated).toEqual(['virtual:void-routes']);
    },
  );

  it.each([
    { command: 'serve' as const, isPreview: false, declared: true },
    { command: 'serve' as const, isPreview: true, declared: false },
    { command: 'build' as const, isPreview: false, declared: false },
  ])(
    'declares the auth config environment for $command (preview $isPreview): $declared',
    ({ command, isPreview, declared }) => {
      const plugin = createRoutingPlugin(createTempRoot(), { isAuthEnabled: () => false });
      const config = (
        getHookHandler(plugin.config) as (config: UserConfig, env: ConfigEnv) => UserConfig | void
      )({}, { command, mode: 'development', isPreview });
      expect(Object.keys(config?.environments ?? {})).toEqual(declared ? ['void_auth_config'] : []);
    },
  );

  it('leaves the auth config environment out of Vite hot updates', () => {
    const plugin = createRoutingPlugin(createTempRoot(), { isAuthEnabled: () => true });
    const hotUpdate = getHookHandler(plugin.hotUpdate) as (this: {
      environment: { name: string };
    }) => unknown;
    expect(hotUpdate.call({ environment: { name: 'void_auth_config' } })).toEqual([]);
    expect(hotUpdate.call({ environment: { name: 'void_worker' } })).toBeUndefined();
  });

  it('resolves deeper better-auth subpaths past the dev client aliases', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'routes', 'health.ts'), 'export const GET = () => new Response();');
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [createRoutingPlugin(root, { isAuthEnabled: () => true })],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
    });
    try {
      const resolve = async (specifier: string, importer: string) =>
        (await server.environments.client.pluginContainer.resolveId(specifier, importer))?.id;
      const fileOf = (specifier: string) =>
        normalizePath(fileURLToPath(import.meta.resolve(specifier)));
      // The app has no better-auth of its own, so these resolve only through the aliases.
      const appFile = join(root, 'routes', 'health.ts');
      for (const specifier of ['better-auth/client', 'better-auth/react']) {
        expect(await resolve(specifier, appFile)).toBe(fileOf(specifier));
      }
      // A deeper subpath passes the aliases and resolves where better-auth is installed.
      expect(await resolve('better-auth/client/plugins', fileURLToPath(import.meta.url))).toBe(
        fileOf('better-auth/client/plugins'),
      );
    } finally {
      await server.close();
    }
  });

  it('regenerates auth files when the auth config or a file it imports changes', async () => {
    // Vite's module graph keys files by real path, as the watcher reports them for a real root;
    // `.native` also expands Windows short names, as Vite does.
    const root = realpathSync.native(createTempRoot());
    const routePath = join(root, 'routes', 'health.ts');
    writeFileSync(routePath, 'export const GET = () => new Response();');
    const authPath = readProjectPaths(root).authConfigCandidates[0]!;
    const helperPath = join(dirname(authPath), 'auth-fields.ts');
    const extraPath = join(dirname(authPath), 'auth-extra.ts');
    // The type-only export makes the file an auth config without loading void/auth.
    const authSource = (imports: string, fields: string) =>
      "export type {} from 'void/auth';\n" +
      imports +
      '\nexport default ({ defaults }) => ({ ...defaults, user: { additionalFields: { ' +
      fields +
      ' } } });';
    const helperImport = "import { field } from './auth-fields.ts';";
    writeFileSync(helperPath, "export const field = 'nickname';");
    writeFileSync(authPath, authSource(helperImport, "[field]: { type: 'string' }"));

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => true });
    // A real dev server, so Vite runs its own watcher handling for the auth
    // environment; events are sent by hand.
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        plugin,
        // Holds back Vite's own handling of each save, so recovery cannot rely on it.
        {
          name: 'slow-watch-change',
          async watchChange() {
            await new Promise((resolve) => setTimeout(resolve, 100));
          },
        },
      ],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
    });
    try {
      const logError = vi.spyOn(server.config.logger, 'error');
      const environment = server.environments.void_auth_config as RunnableDevEnvironment;
      const imports = vi.spyOn(environment.runner, 'import');
      const schemaPath = join(root, '.void', 'better-auth-schema.ts');
      const schema = () => readFileSync(schemaPath, 'utf8');
      const save = (event: 'add' | 'change', path: string, source: string) => {
        writeFileSync(path, source);
        server.watcher.emit(event, path);
      };
      await vi.waitFor(() => expect(schema()).toContain('"nickname"'));

      save(
        'change',
        authPath,
        authSource(helperImport, "[field]: { type: 'string' }, bio: { type: 'string' }"),
      );
      await vi.waitFor(() => expect(schema()).toContain('"bio"'));

      save('change', helperPath, "export const field = 'displayName';");
      await vi.waitFor(() => expect(schema()).toContain('"displayName"'));
      expect(schema()).not.toContain('"nickname"');

      // A save outside the config's files does not load it again.
      const loads = imports.mock.calls.length;
      writeFileSync(routePath, 'export const GET = () => new Response("updated");');
      server.watcher.emit('change', routePath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(imports).toHaveBeenCalledTimes(loads);

      // A syntax error in a helper is reported, and fixing it regenerates.
      save('change', helperPath, 'export const field =');
      await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
      save('change', helperPath, "export const field = 'avatar';");
      await vi.waitFor(() => expect(schema()).toContain('"avatar"'));

      // A load that fails on a missing file retries once the file is created.
      save(
        'change',
        authPath,
        authSource("import { extra } from './auth-extra.ts';", "[extra]: { type: 'string' }"),
      );
      await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(2));
      save('add', extraPath, "export const extra = 'created';");
      await vi.waitFor(() => expect(schema()).toContain('"created"'));
    } finally {
      await server.close();
    }
  });

  it('rescans sourceDir route changes during dev', async () => {
    const root = createBareTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }));
    mkdirSync(join(root, 'src', 'routes'), { recursive: true });

    const onPolicyChange = vi.fn(() => false);
    const plugin = createRoutingPlugin(root, {
      isAuthEnabled: () => false,
      onDevAssetRoutingPolicyChange: onPolicyChange,
    });
    const { emit, invalidated } = startDevServer(plugin, ['virtual:void-routes']);

    const routePath = join(root, 'src', 'routes', 'api.ts');
    writeFileSync(routePath, 'export const GET = () => new Response("ok");\n');
    await emit('add', routePath);

    expect(onPolicyChange).toHaveBeenCalled();
    expect(invalidated).toEqual(['virtual:void-routes']);
    expect(readFileSync(join(root, '.void', 'routes.d.ts'), 'utf-8')).toContain(
      '../src/routes/api.ts',
    );
  });

  it('invalidates sourceDir page manifest changes during dev', async () => {
    const root = createBareTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ sourceDir: 'src' }));
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    const { emit, invalidated } = startDevServer(plugin, PAGE_MODULE_IDS);

    const pagePath = join(root, 'src', 'pages', 'test.tsx');
    writeFileSync(pagePath, 'export default function Test() { return null; }');
    await emit('add', pagePath);

    expect(invalidated).toEqual(PAGE_MODULE_IDS);
  });

  // Manual trigger auth is baked into the route table: dev accepts only the
  // dev trigger header. `vite preview` reports `command: 'serve'` but runs
  // the built bundle, so it must keep the build rule.
  it.each([
    { command: 'serve' as const, isPreview: false, serve: true },
    { command: 'serve' as const, isPreview: true, serve: false },
    { command: 'build' as const, isPreview: false, serve: false },
  ])(
    'compiles trigger auth for $command (preview: $isPreview) as serve=$serve',
    async ({ command, isPreview, serve }) => {
      const root = createTempRoot();
      mkdirSync(join(root, 'crons'), { recursive: true });
      writeFileSync(
        join(root, 'crons', 'sync.ts'),
        'export const cron = "0 * * * *";\nexport default async () => {};\n',
      );

      const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
      const load = getHookHandler(plugin.load) as (id: string) => Promise<string | undefined>;

      runConfig(plugin, {
        command,
        mode: command === 'build' ? 'production' : 'development',
        isPreview,
      });
      resolveConfig(plugin, command);

      const code = await load('virtual:void-routes');
      expect(code).toContain('app.post("/__void/scheduled"');
      expect(code).toContain(`const __VOID_SERVE = ${serve};`);
    },
  );

  // void/live sends the real error message only from the dev server's entry.
  it.each([
    { command: 'serve' as const, isPreview: false, dev: true },
    { command: 'serve' as const, isPreview: true, dev: false },
    { command: 'build' as const, isPreview: false, dev: false },
  ])(
    'writes the live dev flag for $command (preview: $isPreview) as $dev',
    async ({ command, isPreview, dev }) => {
      const root = createTempRoot();
      const plugin = createRoutingPlugin(root, {
        isAuthEnabled: () => false,
        live: { bindingName: 'VOID_LIVE', className: 'VoidLiveStreamDurableObject' },
      });
      const entryPath = join(root, '.void', 'entry.ts');
      expect(readFileSync(entryPath, 'utf-8')).not.toContain('__setLiveDev');

      runConfig(plugin, { command, mode: 'development', isPreview });
      resolveConfig(plugin, command);
      await runBuildStart(plugin);

      const entry = readFileSync(entryPath, 'utf-8');
      expect(entry).toContain('__setLiveBindingName("VOID_LIVE")');
      if (dev) {
        expect(entry).toContain('__setLiveDev(true);');
      } else {
        expect(entry).not.toContain('__setLiveDev');
      }
    },
  );

  it.each([
    { name: 'a native build', command: 'build' as const, enabled: true, emitted: true },
    { name: 'the dev server', command: 'serve' as const, enabled: true, emitted: false },
    { name: 'a managed build', command: 'build' as const, enabled: true, managed: true },
    { name: 'an unset option', command: 'build' as const, enabled: false, emitted: false },
  ])('writes the HTTPS redirect into the Worker entry for $name', async (testCase) => {
    const { command, enabled, managed, emitted = false } = testCase;
    if (managed) {
      vi.stubEnv('VOID_DEPLOY_PROJECT_ID', 'project-id');
    }
    try {
      const root = createTempRoot();
      const plugin = createRoutingPlugin(root, {
        isAuthEnabled: () => false,
        routing: enabled ? { alwaysUseHttps: true } : undefined,
      });
      runConfig(plugin, { command, mode: 'production' });
      resolveConfig(plugin, command);
      await runBuildStart(plugin);

      const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
      expect(entry.includes('alwaysUseHttps: true')).toBe(emitted);
      // The app itself never redirects, so in-process `fetch` stays on HTTP.
      const load = getHookHandler(plugin.load) as (id: string) => Promise<string | undefined>;
      expect(await load('virtual:void-routes')).not.toContain('alwaysUseHttps');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('routingPlugin native asset Worker bypass', () => {
  const CHUNK = 'assets/main-abcdefgh.js';
  const WRANGLER = JSON.stringify({
    name: 'app',
    main: 'index.js',
    assets: {
      binding: 'ASSETS',
      not_found_handling: 'none',
      run_worker_first: ['/**'],
      directory: '../client',
    },
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createBuildRoot(options: { wrangler?: boolean } = {}): string {
    const root = createTempRoot();
    writeFileSync(join(root, 'routes', 'index.ts'), 'export const GET = () => "ok";\n');
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    mkdirSync(join(root, 'dist', 'client', 'assets'), { recursive: true });
    if (options.wrangler !== false) {
      writeFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), WRANGLER);
    }
    return root;
  }

  function clientBundle(): Record<string, unknown> {
    return {
      [CHUNK]: { type: 'chunk', fileName: CHUNK, preliminaryFileName: 'assets/main-!~{001}~.js' },
      '.vite/manifest.json': {
        type: 'asset',
        fileName: '.vite/manifest.json',
        source: JSON.stringify({ 'main.js': { file: CHUNK, isEntry: true } }),
      },
    };
  }

  async function runClientBuild(
    root: string,
    options: Partial<Omit<Parameters<typeof routingPlugin>[1], 'getApplicationAnalysis'>> = {},
    base = '/',
  ): Promise<void> {
    const plugin = createRoutingPlugin(root, {
      isAuthEnabled: () => false,
      assetWorkerBypass: true,
      ...options,
    });
    runConfig(plugin, { command: 'build', mode: 'production' });
    (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
      build: { assetsDir: 'assets' },
      base,
      root,
      publicDir: join(root, 'public'),
      command: 'build',
      mode: 'production',
      plugins: [],
    } as unknown as ResolvedConfig);
    await runBuildStart(plugin);
    const environment = {
      name: 'client',
      config: { build: { manifest: true, outDir: 'dist/client', assetsDir: 'assets' } },
    };
    (getHookHandler(plugin.generateBundle) as (...args: Array<unknown>) => void).call(
      { environment },
      {},
      clientBundle(),
    );
    (getHookHandler(plugin.writeBundle) as (...args: Array<unknown>) => void).call(
      { environment },
      {},
      {},
    );
  }

  const wranglerText = (root: string) =>
    readFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), 'utf8');
  const headersPath = (root: string) => join(root, 'dist', 'client', '_headers');

  it('excludes the hashed chunk from the Worker and lists it as immutable', async () => {
    const root = createBuildRoot();
    await runClientBuild(root);
    const wrangler = JSON.parse(wranglerText(root));
    expect(wrangler.assets.run_worker_first).toEqual(['/**', `!/${CHUNK}`]);
    expect({ ...wrangler, assets: { ...wrangler.assets, run_worker_first: ['/**'] } }).toEqual(
      JSON.parse(WRANGLER),
    );
    const headers = readFileSync(headersPath(root), 'utf8');
    expect(headers.split('\n')[0]).toBe(GENERATED_ASSET_HEADERS_MARKER);
    expect(headers).toContain(`/${CHUNK}\n  Cache-Control: public, max-age=31536000, immutable\n`);
  });

  it('keeps the bypass when HTTPS enforcement is the only rule', async () => {
    const root = createBuildRoot();
    await runClientBuild(root, { routing: { alwaysUseHttps: true } });
    expect(JSON.parse(wranglerText(root)).assets.run_worker_first).toEqual(['/**', `!/${CHUNK}`]);
    expect(readFileSync(headersPath(root), 'utf8')).toContain(`/${CHUNK}\n`);
  });

  it('keeps the Worker in front when HTTPS enforcement comes with a header rule', async () => {
    const root = createBuildRoot();
    await runClientBuild(root, {
      routing: { alwaysUseHttps: true, headers: { '/*': ['X-Frame-Options: DENY'] } },
    });
    expect(wranglerText(root)).toBe(WRANGLER);
    expect(existsSync(headersPath(root))).toBe(false);
  });

  it('rewrites its own _headers on the next build', async () => {
    const root = createBuildRoot();
    writeFileSync(
      headersPath(root),
      `${GENERATED_ASSET_HEADERS_MARKER}\n/assets/old-12345678.js\n`,
    );
    await runClientBuild(root);
    const headers = readFileSync(headersPath(root), 'utf8');
    expect(headers).toContain(`/${CHUNK}`);
    expect(headers).not.toContain('old-12345678');
  });

  it.each<[string, (root: string) => void, Parameters<typeof runClientBuild>[1]?, string?]>([
    ['managed builds', () => vi.stubEnv('VOID_DEPLOY_PROJECT_ID', 'project-id')],
    [
      'global middleware',
      (root) => {
        mkdirSync(join(root, 'middleware'));
        writeFileSync(
          join(root, 'middleware', '01.log.ts'),
          'export default async (_c, next) => next();\n',
        );
      },
    ],
    [
      'a routing header rule',
      () => {},
      { routing: { headers: { '/*': ['X-Frame-Options: DENY'] } } },
    ],
    [
      'a public _headers file',
      (root) => {
        mkdirSync(join(root, 'public'));
        writeFileSync(join(root, 'public', '_headers'), '');
      },
    ],
    ['a non-root base', () => {}, {}, '/app/'],
    ['the option unset', () => {}, { assetWorkerBypass: undefined }],
    [
      'a route under the assets folder',
      (root) => {
        mkdirSync(join(root, 'routes', 'assets'));
        writeFileSync(join(root, 'routes', 'assets', '[id].ts'), 'export const GET = () => "";\n');
      },
    ],
    [
      'a page under the assets folder',
      (root) => {
        mkdirSync(join(root, 'pages', 'assets'), { recursive: true });
        writeFileSync(join(root, 'pages', 'assets', '[id].tsx'), 'export default () => null;\n');
      },
    ],
    ['a redirect rule', () => {}, { routing: { redirects: { '/old': '/new' } } }],
    ['a fallback rule', () => {}, { routing: { fallbacks: { '/*': '/index.html' } } }],
    [
      'a public _redirects file',
      (root) => {
        mkdirSync(join(root, 'public'));
        writeFileSync(join(root, 'public', '_redirects'), '');
      },
    ],
    [
      'a revalidate key under the assets folder',
      () => {},
      { routing: { revalidate: { '/assets/*': 60 } } },
    ],
    ['a prerender path under the assets folder', () => {}, { prerenderPaths: ['/assets/page'] }],
  ])('leaves the output unchanged for %s', async (_name, prepare, options, base) => {
    const root = createBuildRoot();
    prepare(root);
    await runClientBuild(root, options, base);
    expect(wranglerText(root)).toBe(WRANGLER);
    expect(existsSync(headersPath(root))).toBe(false);
  });

  it('keeps a user-authored _headers file and the Worker in front', async () => {
    const root = createBuildRoot();
    const userHeaders = '/assets/*\n  X-Frame-Options: DENY\n';
    writeFileSync(headersPath(root), userHeaders);
    await runClientBuild(root);
    expect(wranglerText(root)).toBe(WRANGLER);
    expect(readFileSync(headersPath(root), 'utf8')).toBe(userHeaders);
  });

  it('removes its stale _headers when the app is no longer eligible', async () => {
    const root = createBuildRoot();
    writeFileSync(headersPath(root), `${GENERATED_ASSET_HEADERS_MARKER}\n/${CHUNK}\n`);
    await runClientBuild(root, { routing: { headers: { '/*': ['X-Frame-Options: DENY'] } } });
    expect(wranglerText(root)).toBe(WRANGLER);
    expect(existsSync(headersPath(root))).toBe(false);
  });

  function writeEarlierBypass(root: string): void {
    const wrangler = JSON.parse(WRANGLER);
    wrangler.assets.run_worker_first = ['/**', '!/assets/old-12345678.js'];
    writeFileSync(join(root, 'dist', 'ssr', 'wrangler.json'), JSON.stringify(wrangler));
  }

  it('refreshes an earlier bypass on a client-only watch rebuild', async () => {
    const root = createBuildRoot();
    writeEarlierBypass(root);
    await runClientBuild(root);
    expect(JSON.parse(wranglerText(root)).assets.run_worker_first).toEqual(['/**', `!/${CHUNK}`]);
    expect(readFileSync(headersPath(root), 'utf8')).toContain(`/${CHUNK}\n`);
  });

  it('sends every path to the Worker again when a client-only rebuild is not eligible', async () => {
    const root = createBuildRoot();
    writeEarlierBypass(root);
    await runClientBuild(root, { routing: { headers: { '/*': ['X-Frame-Options: DENY'] } } });
    expect(wranglerText(root)).toBe(WRANGLER);
    expect(existsSync(headersPath(root))).toBe(false);
  });

  it('writes nothing without a built wrangler.json', async () => {
    const root = createBuildRoot({ wrangler: false });
    await runClientBuild(root);
    expect(existsSync(join(root, 'dist', 'ssr', 'wrangler.json'))).toBe(false);
    expect(existsSync(headersPath(root))).toBe(false);
  });
});

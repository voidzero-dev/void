import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, ResolvedConfig, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import { readConfig } from '../../src/config.ts';
import { resolveImageConfig } from '../../src/image-config.ts';
import { routingPlugin } from '../../src/plugin-routing.ts';
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

function resolveConfig(plugin: RoutingPlugin, command: 'build' | 'serve'): void {
  (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
    build: { assetsDir: 'assets' },
    command,
    mode: command === 'build' ? 'production' : 'development',
    plugins: [],
  } as unknown as ResolvedConfig);
}

async function runBuildStart(plugin: RoutingPlugin): Promise<void> {
  await (getHookHandler(plugin.buildStart) as () => Promise<void>).call({} as never);
}

function fakeDevServer(moduleIds: Array<string> = []) {
  const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
  const invalidated: Array<string> = [];
  const restart = vi.fn(async () => {});
  const modules = new Map(moduleIds.map((id) => [id, { id }]));
  const server = {
    watcher: {
      on(event: string, handler: (path: string) => Promise<void> | void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    environments: {
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
  return { server, invalidated, restart, emit };
}

function startDevServer(plugin: RoutingPlugin, moduleIds?: Array<string>) {
  const dev = fakeDevServer(moduleIds);
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

  it('does not invalidate page renderer modules for component-only page saves', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    const pagePath = join(root, 'pages', 'index.tsx');
    writeFileSync(pagePath, 'export default function Index() { return null; }');

    const plugin = createRoutingPlugin(root, { isAuthEnabled: () => false });
    const { emit, invalidated } = startDevServer(plugin, PAGE_MODULE_IDS);

    writeFileSync(pagePath, 'export default function Index() { return <h1>Updated</h1>; }');
    await emit('change', pagePath);

    expect(invalidated).toEqual(['virtual:void-routes']);
  });

  it('mounts the image optimizer when a dev change adds Image usage and keeps it on recompiles', async () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'routes', 'api.ts'), 'export const GET = () => new Response();\n');
    const config = resolveImageConfig(undefined, { root, dev: true });
    const onPolicyChange = vi.fn(() => false);
    const plugin = createRoutingPlugin(root, {
      isAuthEnabled: () => false,
      onDevAssetRoutingPolicyChange: onPolicyChange,
      images: {
        getMountedConfig: (usesImageOptimizer) => (usesImageOptimizer ? config : undefined),
        imageSources: new Set(),
      },
    });
    const load = getHookHandler(plugin.load) as (id: string) => Promise<string>;
    runConfig(plugin, { command: 'serve', mode: 'development' });
    resolveConfig(plugin, 'serve');
    await runBuildStart(plugin);
    expect(await load('virtual:void-routes')).not.toContain('__createImageHandler');
    const { emit } = startDevServer(plugin, ['virtual:void-routes']);

    // An API route keeps the SPA asset policy, which must list the endpoint.
    mkdirSync(join(root, 'routes', 'api'), { recursive: true });
    const ogPath = join(root, 'routes', 'api', 'og.ts');
    writeFileSync(
      ogPath,
      'import { getImageProps } from "void/image";\nexport const GET = () => Response.json(getImageProps({ src: "/a.png", alt: "", width: 8, height: 8 }).props);\n',
    );
    await emit('add', ogPath);
    expect(onPolicyChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        assetConfig: expect.objectContaining({
          run_worker_first: expect.arrayContaining(['/_void/image']),
        }),
      }),
    );
    expect(await load('virtual:void-routes')).toContain(
      'app.all("/_void/image", __createImageHandler(',
    );

    writeFileSync(join(root, 'routes', 'api.ts'), 'export const GET = () => new Response("2");\n');
    await emit('change', join(root, 'routes', 'api.ts'));
    expect(await load('virtual:void-routes')).toContain(
      'app.all("/_void/image", __createImageHandler(',
    );
  });

  it.each([
    ['the default asset file names', {}, ['assets/hero-abc.png']],
    ['a function assetFileNames', { assetFileNames: () => 'assets/[name].[ext]' }, undefined],
  ])('stamps ?image sources in the client manifest with %s', (_name, output, immutableFiles) => {
    const plugin = createRoutingPlugin(createBareTempRoot(), {
      isAuthEnabled: () => false,
      images: { getMountedConfig: () => undefined, imageSources: new Set(['src/hero.png']) },
    });
    const manifest = {
      'src/hero.png': { file: 'assets/hero-abc.png', src: 'src/hero.png' },
      'src/other.png': { file: 'assets/other-def.png', src: 'src/other.png' },
    };
    const bundle: Record<string, { type: string; fileName: string; source: string }> = {
      '.vite/manifest.json': {
        type: 'asset',
        fileName: '.vite/manifest.json',
        source: JSON.stringify(manifest),
      },
      'assets/hero-abc.png': { type: 'asset', fileName: 'assets/hero-abc.png', source: '' },
      'assets/other-def.png': { type: 'asset', fileName: 'assets/other-def.png', source: '' },
    };
    (getHookHandler(plugin.generateBundle) as (...args: Array<unknown>) => void).call(
      {
        environment: {
          name: 'client',
          config: { build: { manifest: true, rolldownOptions: { output } } },
        },
      },
      {},
      bundle,
    );

    const stamped = JSON.parse(bundle['.vite/manifest.json']!.source) as Record<
      string,
      { immutableFiles?: Array<string> }
    >;
    expect(stamped['src/hero.png']!.immutableFiles).toEqual(immutableFiles);
    expect(stamped['src/other.png']!.immutableFiles).toBeUndefined();
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
});

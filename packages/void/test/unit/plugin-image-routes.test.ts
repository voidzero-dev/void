import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, Plugin, ResolvedConfig, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ImagePluginApi } from '../../src/plugin-image.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

type MockCloudflarePlugin = Plugin & {
  api: { pluginConfig: { config: (resolved: Record<string, unknown>) => Record<string, unknown> } };
};

vi.mock('@cloudflare/vite-plugin', () => import('../helpers/cloudflare-vite-plugin.ts'));

const tempDirs: Array<string> = [];

const IMAGE_COMPONENT = `
import { Image } from "@void/react";

export function Hero() {
  return <Image src="/hero.png" alt="" width={640} height={320} />;
}
`;

const SERVE: ConfigEnv = { command: 'serve', mode: 'development' };
const BUILD: ConfigEnv = { command: 'build', mode: 'production' };

function createProjectRoot(
  voidConfig: Record<string, unknown> = {},
  sources: Record<string, string> = { 'src/components/Hero.tsx': IMAGE_COMPONENT },
): string {
  const root = mkdtempSync(join(tmpdir(), 'void-image-routes-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' }, ...voidConfig }),
  );
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(join(root, 'routes/api/health.ts'), 'export const GET = () => Response.json({});');
  for (const [file, code] of Object.entries(sources)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), code);
  }
  return root;
}

async function createPlugins(root: string): Promise<Array<Plugin>> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { voidPlugin } = await import('../../src/index.ts');
  return voidPlugin();
}

function findPlugin(plugins: Array<Plugin>, name: string): Plugin {
  const plugin = plugins.find((entry) => entry.name === name);
  if (!plugin) {
    throw new Error(`Expected plugin ${name}.`);
  }
  return plugin;
}

/** Run the config hooks in Vite's order (`enforce: 'pre'` first). */
function runConfigHooks(plugins: Array<Plugin>, env: ConfigEnv): void {
  const ordered = [
    ...plugins.filter((plugin) => plugin.enforce === 'pre'),
    ...plugins.filter((plugin) => plugin.enforce === undefined),
  ];
  for (const plugin of ordered) {
    if (plugin.name === 'void:env-schema' || !plugin.config) {
      continue;
    }
    (getHookHandler(plugin.config) as (config: UserConfig, env: ConfigEnv) => unknown).call(
      {},
      {},
      env,
    );
  }
}

/** Compile the route table and worker entry through the routing plugin's hooks. */
async function compileRoutes(root: string, plugins: Array<Plugin>, env: ConfigEnv) {
  runConfigHooks(plugins, env);
  const routing = findPlugin(plugins, 'void:routing');
  (getHookHandler(routing.configResolved) as (config: ResolvedConfig) => void)({
    build: { assetsDir: 'assets' },
    command: env.command,
    mode: env.mode,
    plugins: [],
    publicDir: '',
  } as unknown as ResolvedConfig);
  await (getHookHandler(routing.buildStart) as () => Promise<void>).call({} as never);
  const routes = await (
    getHookHandler(routing.load) as (
      this: { environment: { name: string } },
      id: string,
    ) => Promise<string>
  ).call({ environment: { name: 'void_worker' } }, 'virtual:void-routes');
  // Node targets write `.void/app.ts` instead of a Worker entry.
  const entryPath = join(root, '.void', 'entry.ts');
  const entry = existsSync(entryPath) ? readFileSync(entryPath, 'utf8') : '';
  return { routes, entry };
}

function resolveAssets(plugins: Array<Plugin>, env: ConfigEnv) {
  const envPlugin = findPlugin(plugins, 'void:env');
  (getHookHandler(envPlugin.config) as (config: UserConfig, env: ConfigEnv) => void)({}, env);
  const cloudflarePlugin = plugins.find(
    (plugin): plugin is MockCloudflarePlugin => plugin.name === 'mock:cloudflare',
  )!;
  return cloudflarePlugin.api.pluginConfig.config({}).assets as {
    run_worker_first?: Array<string>;
  };
}

function imageApi(plugins: Array<Plugin>): ImagePluginApi {
  return findPlugin(plugins, 'void:image').api as ImagePluginApi;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('voidPlugin image optimizer wiring', () => {
  it.each([
    ['dev', SERVE],
    ['build', BUILD],
  ] as const)('mounts the endpoint for an app that renders Image (%s)', async (_name, env) => {
    const root = createProjectRoot();
    const plugins = await createPlugins(root);

    const { routes } = await compileRoutes(root, plugins, env);

    expect(routes).toContain('app.all("/_void/image", __createImageHandler(');
    expect(imageApi(plugins).getConfig()?.dev).toBe(env.command === 'serve');
  });

  it('routes the endpoint to the Worker before the SPA shell', async () => {
    const root = createProjectRoot();
    const plugins = await createPlugins(root);
    expect(resolveAssets(plugins, BUILD).run_worker_first).toEqual([
      '/api',
      '/api/*',
      '/__void',
      '/__void/*',
      '/_void/image',
    ]);
    // Endpoint errors stay errors instead of becoming the SPA shell.
    const { entry } = await compileRoutes(root, plugins, BUILD);
    expect(entry).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":false,"notFound":"single-page-application","skipPaths":["/_void/image"]});',
    );
  });

  it('keeps self-hosted ISR away from the endpoint', async () => {
    vi.stubEnv('VOID_DEPLOY_PROJECT_ID', '');
    const root = createProjectRoot({ routing: { revalidate: 60 } });
    const { entry } = await compileRoutes(root, await createPlugins(root), BUILD);

    expect(entry).toContain(
      'isr: { deploymentId: __VOID_ISR_DEPLOYMENT_ID, bypassPaths: ["/_void/image"], handle:',
    );
  });

  it('emits no route, asset rule or ISR bypass for an app without Image', async () => {
    vi.stubEnv('VOID_DEPLOY_PROJECT_ID', '');
    const root = createProjectRoot({ routing: { revalidate: 60 } }, {});
    const plugins = await createPlugins(root);
    const { routes, entry } = await compileRoutes(root, plugins, BUILD);

    expect(routes).not.toContain('__createImageHandler');
    expect(entry).not.toContain('bypassPaths');
    expect(entry).not.toContain('skipPaths');
    expect(entry).toContain('isr: { deploymentId: __VOID_ISR_DEPLOYMENT_ID, handle:');
    expect(resolveAssets(plugins, BUILD).run_worker_first).toEqual([
      '/api',
      '/api/*',
      '/__void',
      '/__void/*',
    ]);
  });

  it('mounts the endpoint at the pathname of an absolute images.path', async () => {
    const root = createProjectRoot({ images: { path: 'https://cdn.example.com/_next/image' } });
    const plugins = await createPlugins(root);
    const { routes } = await compileRoutes(root, plugins, BUILD);

    expect(routes).toContain('app.all("/_next/image", __createImageHandler(');
    expect(imageApi(plugins).getConfig()?.path).toBe('https://cdn.example.com/_next/image');
    expect(resolveAssets(plugins, BUILD).run_worker_first).toContain('/_next/image');
  });

  it('mounts the endpoint for inference.bindings.images without detected usage', async () => {
    const root = createProjectRoot({ inference: { bindings: { images: true } } }, {});
    const { routes } = await compileRoutes(root, await createPlugins(root), BUILD);
    expect(routes).toContain('app.all("/_void/image", __createImageHandler(');
  });

  it.each([
    ['target: "node"', { target: 'node' }],
    ['output: "static"', { output: 'static' }],
    ['images.unoptimized', { images: { unoptimized: true } }],
    ['the cloudflare loader', { images: { loader: 'cloudflare' } }],
  ])('resolves %s without an endpoint', async (_name, voidConfig) => {
    const root = createProjectRoot(voidConfig);
    const plugins = await createPlugins(root);
    const { routes } = await compileRoutes(root, plugins, BUILD);
    const resolved = imageApi(plugins).getConfig()!;

    expect(routes).not.toContain('__createImageHandler');
    expect(imageApi(plugins).getMountedConfig(true)).toBeUndefined();
    if (!('images' in voidConfig)) {
      expect(resolved.noOptimizer).toBe(true);
    }
  });

  it('resolves Void Platform builds without an optimizer or an endpoint', async () => {
    vi.stubEnv('VOID_DEPLOY_PROJECT_ID', 'proj_1');
    const root = createProjectRoot();
    const plugins = await createPlugins(root);
    const { routes } = await compileRoutes(root, plugins, BUILD);

    expect(imageApi(plugins).getConfig()?.noOptimizer).toBe(true);
    expect(routes).not.toContain('__createImageHandler');
  });

  it('registers the image plugin for Void apps only', async () => {
    expect((await createPlugins(createProjectRoot())).map((plugin) => plugin.name)).toContain(
      'void:image',
    );
    vi.restoreAllMocks();
    expect(
      (await createPlugins(createProjectRoot({ target: 'node' }))).map((plugin) => plugin.name),
    ).toContain('void:image');
    vi.restoreAllMocks();
    const framework = createProjectRoot();
    writeFileSync(
      join(framework, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { vinext: '^0.0.5', react: '^19.0.0' } }),
    );
    expect((await createPlugins(framework)).map((plugin) => plugin.name)).not.toContain(
      'void:image',
    );
  });

  it('reports invalid loader combinations as config errors', async () => {
    const plugins = await createPlugins(createProjectRoot({ images: { loader: 'imgix' } }));
    expect(() => runConfigHooks(plugins, BUILD)).toThrow(
      'config: Invalid "images" in void.json. Specified images.loader property (imgix) also requires images.path property',
    );
  });

  it('warns once about ignored and deprecated images keys', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = createProjectRoot({
      images: { domains: ['cdn.example.com'], maximumDiskCacheSize: 0 },
    });
    // `vite build` resolves the config, and calls voidPlugin(), once per environment.
    await createPlugins(root);
    await createPlugins(root);
    const messages = log.mock.calls.map((call) => String(call[0]));

    expect(messages.filter((message) => message.includes('images.domains'))).toHaveLength(1);
    expect(
      messages.filter((message) => message.includes('images.maximumDiskCacheSize')),
    ).toHaveLength(1);
    expect(messages.join('\n')).toContain('Please update void.json to protect your application');
    expect(messages.join('\n')).toContain('"images.maximumDiskCacheSize" in void.json is ignored');
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkerAssetsDir, readBuildOutput } from '@cloudflare/build-output-utils';
import { createBuilder, preview, resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { prepareCfBuildOutput } from '../../src/deploy.ts';
import {
  nativeAuxiliaryWorkers,
  toNativeCloudflareConfig,
} from '../../src/plugin-cloudflare-config.ts';
import { cloudflare } from '../../src/plugin-cloudflare.ts';

const roots: Array<string> = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-v2-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', name: 'void-cf-v2' }));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Cloudflare v2 compatibility', () => {
  it('selects named environments explicitly without letting production mode select one', () => {
    const root = project();
    expect(toNativeCloudflareConfig({}, root).worker?.name).toBe('void-cf-v2');
    const raw = {
      name: 'base',
      vars: { COLOR: 'base' },
      env: {
        production: { name: 'production-app', vars: { COLOR: 'production' } },
        staging: { name: 'staging-app', vars: { COLOR: 'staging' } },
      },
    };
    vi.stubEnv('CLOUDFLARE_ENV', undefined);
    expect(toNativeCloudflareConfig(raw, root).worker?.name).toBe('base');
    vi.stubEnv('CLOUDFLARE_ENV', 'staging');
    expect(toNativeCloudflareConfig(raw, root).worker).toMatchObject({
      name: 'staging-app',
      env: { COLOR: { value: 'staging' } },
    });
    vi.stubEnv('CLOUDFLARE_ENV', 'production');
    expect(toNativeCloudflareConfig(raw, root).worker?.name).toBe('production-app');
  });

  it('keeps Container builds deferred and prepares their native declarations without Docker', async () => {
    const root = project();
    writeFileSync(
      join(root, 'worker.js'),
      "export class Box {}\nexport default { fetch: () => new Response('ok') };\n",
    );
    writeFileSync(
      join(root, 'helper.js'),
      "export default { fetch: () => new Response('helper') };",
    );
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: cloudflare({
        config: () => ({
          name: 'container-app',
          main: 'worker.js',
          compatibility_date: '2026-02-24',
          durable_objects: { bindings: [{ name: 'BOX', class_name: 'Box' }] },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['Box'] }],
          containers: [{ name: 'box', class_name: 'Box', image: 'docker.io/example/box:1' }],
        }),
        viteEnvironment: { name: 'ssr' },
        auxiliaryWorkers: [
          {
            config: { name: 'helper', main: 'helper.js', compatibility_date: '2026-02-24' },
            viteEnvironment: { name: 'helper' },
          },
        ],
      }),
    });
    await builder.buildApp();
    const artifact = await prepareCfBuildOutput(root);
    expect(artifact).not.toBeNull();
    try {
      const prepared = await readBuildOutput(artifact!.directory);
      expect(Object.values(prepared.workers).map((worker) => worker.config.name)).toContain(
        'helper',
      );
      expect(prepared.containers).toHaveLength(1);
      expect(prepared.containers[0]?.config).toMatchObject({
        name: 'box',
        image: { reference: 'docker.io/example/box:1' },
      });
    } finally {
      await artifact?.dispose();
    }
    const metadataPath = join(root, '.cloudflare/output/v0/void-containers.json');
    writeFileSync(metadataPath, JSON.stringify({ workerDirectory: '../outside' }));
    await expect(prepareCfBuildOutput(root)).rejects.toThrow('Invalid Void Container');
  });

  it('preserves resource identities, required secrets and compatibility settings', () => {
    const root = project();
    const config = toNativeCloudflareConfig(
      {
        name: 'existing-app',
        main: './worker.ts',
        account_id: 'account-id',
        compatibility_date: '2026-02-24',
        compatibility_flags: ['nodejs_compat'],
        d1_databases: [{ binding: 'DB', database_name: 'existing', database_id: 'existing-id' }],
        kv_namespaces: [{ binding: 'CACHE', id: 'existing-cache' }],
        secrets: { required: ['API_KEY'] },
      },
      root,
    );
    expect(config.accountId).toBe('account-id');
    expect(config.worker).toMatchObject({
      name: 'existing-app',
      entrypoint: join(root, 'worker.ts'),
      compatibilityFlags: ['nodejs_compat'],
      env: {
        DB: { id: 'existing-id' },
        CACHE: { id: 'existing-cache' },
        API_KEY: { type: 'secret' },
      },
    });
  });

  it('adapts file and callback auxiliary worker options without executing the entry', () => {
    const root = project();
    mkdirSync(join(root, 'aux'));
    writeFileSync(
      join(root, 'aux/wrangler.toml'),
      'name = "helper"\nmain = "./worker.ts"\ncompatibility_date = "2026-02-24"\n',
    );
    const callback = vi.fn((_config, { entryWorkerConfig }) => ({
      vars: { OWNER: entryWorkerConfig.name },
    }));
    const workers = nativeAuxiliaryWorkers(
      [{ configPath: 'aux/wrangler.toml', config: callback, devOnly: true }],
      root,
    )!;
    const config = (
      workers[0]!.config as (input: {
        entryWorkerConfig: {
          name: string;
          compatibilityDate: string;
          compatibilityFlags: Array<string>;
        };
      }) => unknown
    )({
      entryWorkerConfig: { name: 'entry', compatibilityDate: '2026-02-24', compatibilityFlags: [] },
    });
    expect(config).toMatchObject({
      name: 'helper',
      entrypoint: join(root, 'aux/worker.ts'),
      env: { OWNER: { type: 'text', value: 'entry' } },
    });
    expect(workers[0]!.devOnly).toBe(true);
  });

  it('keeps local values in memory and never overwrites an authored native config', async () => {
    const root = project();
    const plugins = () =>
      cloudflare({
        config: () => ({
          name: 'app',
          main: 'virtual:entry',
          vars: { LOCAL_SECRET: 'local-only' },
        }),
        viteEnvironment: { name: 'ssr' },
      });
    await resolveConfig({ root, configFile: false, plugins: plugins() }, 'serve');
    const generated = readFileSync(join(root, 'cloudflare.config.ts'), 'utf8');
    expect(generated).not.toContain('local-only');
    writeFileSync(join(root, 'cloudflare.config.ts'), 'export default { authored: true };');
    await expect(
      resolveConfig({ root, configFile: false, plugins: plugins() }, 'serve'),
    ).rejects.toThrow('authored cloudflare.config.ts');
    expect(readFileSync(join(root, 'cloudflare.config.ts'), 'utf8')).toBe(
      'export default { authored: true };',
    );
  });

  it('builds native output and the existing dist layout, then previews the native artifact', async () => {
    const root = project();
    writeFileSync(
      join(root, 'worker.js'),
      "export default { fetch: (_request, env) => new Response(env.PREVIEW_VALUE ?? 'built-worker') };",
    );
    writeFileSync(join(root, 'index.html'), '<p>asset</p>');
    const plugins = () =>
      cloudflare({
        config: () => ({
          name: 'app',
          main: './worker.js',
          compatibility_date: '2026-02-24',
          assets: { binding: 'ASSETS', directory: './public', run_worker_first: true },
        }),
        inspectorPort: false,
        viteEnvironment: { name: 'ssr' },
      });
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: plugins(),
      logLevel: 'silent',
    });
    await builder.buildApp();
    const output = await readBuildOutput(root);
    expect(output.workers.default.config.manifest?.mainModule).toBe('index.js');
    expect(existsSync(join(root, 'dist/ssr/index.js'))).toBe(true);
    expect(existsSync(join(root, 'dist/client/index.html'))).toBe(true);
    expect(existsSync(join(getWorkerAssetsDir(root), 'index.html'))).toBe(true);
    expect(readFileSync(join(root, 'dist/ssr/wrangler.json'), 'utf8')).toContain(
      '"main": "index.js"',
    );
    writeFileSync(join(root, '.env'), 'PREVIEW_VALUE=local-preview-only');
    // Exercise the native plugin's Worker runtime as well as its build output.
    const server = await preview({
      root,
      configFile: false,
      plugins: plugins(),
      logLevel: 'silent',
      server: { port: 0 },
    });
    try {
      const response = await fetch(server.resolvedUrls!.local[0]!);
      expect(await response.text()).toBe('local-preview-only');
      expect((await readBuildOutput(root)).workers.default.config.env).not.toHaveProperty(
        'PREVIEW_VALUE',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

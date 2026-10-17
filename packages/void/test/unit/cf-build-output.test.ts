import { spawnSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getWorkerAssetsDir,
  getWorkerBundleDir,
  getWorkerConfigPath,
  getRootConfigPath,
  readBuildOutput,
  writeRootConfig,
  writeWorkerConfig,
  writeContainerConfig,
} from '@cloudflare/build-output-utils';
import { cloudflare } from '@cloudflare/vite-plugin';
import { renderCloudflareStaticEntry } from '@void/deploy-cloudflare';
import { toSlash } from 'pathslash';
import { createBuilder } from 'vite';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  type CfBuildOutput,
  prepareCfFrameworkBuildOutput,
  prepareCfStaticBuildOutput,
} from '../../src/cli/cf-build-output.ts';
import { prepareCfBuildOutput } from '../../src/deploy.ts';

const roots: Array<string> = [];
// These tests start a real cf CLI process (and one also runs a Vite build).
// Windows CI can take longer than Vitest's 5-second default under parallel load.
const CF_BUILD_TIMEOUT_MS = process.platform === 'win32' ? 45_000 : 15_000;
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function worker(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-build-output-test-'));
  roots.push(root);
  const output = join(root, 'dist', 'ssr');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'index.js'),
    'export default { fetch() { return new Response("ok") } };\n',
  );
  writeFileSync(join(output, 'wrangler.json'), JSON.stringify(config));
  return output;
}

/** Run `check` against the prepared output, then dispose it. */
async function withPrepared(
  pending: Promise<CfBuildOutput | null>,
  check: (prepared: CfBuildOutput) => unknown,
): Promise<CfBuildOutput> {
  const prepared = await pending;
  if (!prepared) {
    throw new Error('Expected cf build output.');
  }
  try {
    await check(prepared);
  } finally {
    await prepared.dispose();
  }
  return prepared;
}

function expectCfDryRun(directory: string, command = ['workers', 'versions', 'create']) {
  const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
  const dryRun = spawnSync(process.execPath, [cf, ...command, '--prebuilt', '--dry-run'], {
    cwd: directory,
    encoding: 'utf8',
  });
  expect(dryRun.status, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
  return dryRun;
}

async function nativeBuild() {
  const root = mkdtempSync(join(tmpdir(), 'void-native-cf-output-'));
  roots.push(root);
  await writeRootConfig(
    root,
    { accountId: 'account-id', complianceRegion: 'public' },
    { isPreview: false, mode: 'staging' },
  );
  const bundle = getWorkerBundleDir(root);
  mkdirSync(join(bundle, 'assets'), { recursive: true });
  writeFileSync(
    join(bundle, 'index.js'),
    'import data from "./assets/message.txt"; export default { fetch() { return new Response(data) } };',
  );
  writeFileSync(join(bundle, 'assets/message.txt'), 'native text');
  writeFileSync(join(bundle, 'assets/font.woff2'), Buffer.from([0, 255, 4, 128]));
  writeFileSync(join(bundle, 'assets/runtime.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(join(bundle, 'index.js.map'), '{"version":3,"sourcesContent":["original source"]}');
  await writeWorkerConfig({
    root,
    config: {
      name: 'void-native-test',
      compatibilityDate: '2026-10-12',
      env: { DATA: { type: 'r2', name: 'native-bucket' }, TOKEN: { type: 'secret' } },
    },
    manifest: {
      type: 'partial',
      mainModule: 'index.js',
      modules: {
        'assets/message.txt': { type: 'text' },
        'assets/font.woff2': { type: 'data' },
        'assets/runtime.wasm': { type: 'wasm' },
      },
    },
  });
  mkdirSync(getWorkerAssetsDir(root), { recursive: true });
  writeFileSync(join(getWorkerAssetsDir(root), 'index.html'), '<h1>native</h1>');
  return root;
}

it(
  'prepares native output with complete module types, original mode and unchanged source files',
  async () => {
    const root = await nativeBuild();
    const paths = [
      getRootConfigPath(root),
      getWorkerConfigPath(root),
      join(getWorkerBundleDir(root), 'assets/font.woff2'),
      join(getWorkerBundleDir(root), 'index.js.map'),
    ];
    const before = paths.map((path) => readFileSync(path));
    await withPrepared(prepareCfBuildOutput(root), async (prepared) => {
      const result = await readBuildOutput(prepared.directory);
      expect(result.rootConfig).toMatchObject({
        accountId: 'account-id',
        complianceRegion: 'public',
        buildContext: { mode: 'staging', isPreview: false },
      });
      expect(result.workers.default.config.manifest).toMatchObject({
        type: 'complete',
        mainModule: 'index.js',
        modules: {
          'index.js': { type: 'esm' },
          'index.js.map': { type: 'sourcemap' },
          'assets/message.txt': { type: 'text' },
          'assets/font.woff2': { type: 'data' },
          'assets/runtime.wasm': { type: 'wasm' },
        },
      });
      expect(result.workers.default.config.env).toMatchObject({
        DATA: { type: 'r2', name: 'native-bucket' },
        TOKEN: { type: 'secret' },
      });
      expect(
        readFileSync(join(getWorkerBundleDir(prepared.directory), 'assets/font.woff2')),
      ).toEqual(before[2]);
      expect(
        readFileSync(join(getWorkerBundleDir(prepared.directory), 'assets/runtime.wasm')),
      ).toEqual(readFileSync(join(getWorkerBundleDir(root), 'assets/runtime.wasm')));
      expect(readFileSync(join(getWorkerBundleDir(prepared.directory), 'index.js.map'))).toEqual(
        before[3],
      );
      expect(
        readFileSync(join(getWorkerAssetsDir(prepared.directory), 'index.html'), 'utf8'),
      ).toContain('native');
      expectCfDryRun(prepared.directory);
    });
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  },
  CF_BUILD_TIMEOUT_MS,
);

it('rejects native artifact account and mode mismatches', async () => {
  const root = await nativeBuild();
  await expect(prepareCfBuildOutput(root, { accountId: 'another-account' })).resolves.toBeNull();
  await expect(prepareCfBuildOutput(root, { mode: 'production' })).resolves.toBeNull();
});

it('preserves native auxiliary Workers and already-built Container declarations', async () => {
  const root = await nativeBuild();
  const bundle = getWorkerBundleDir(root, 'auxiliary');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, 'index.js'),
    'export default { fetch() { return new Response("aux") } };',
  );
  await writeWorkerConfig({
    root,
    directoryName: 'auxiliary',
    config: {
      name: 'void-native-aux',
      compatibilityDate: '2026-10-12',
    },
    manifest: { type: 'partial', mainModule: 'index.js', modules: {} },
  });
  await writeContainerConfig({
    root,
    directoryName: 'container',
    config: {
      name: 'native-container',
      maxInstances: 2,
      image: { reference: 'docker.io/example/native:1' },
    },
  });
  await withPrepared(
    prepareCfBuildOutput(root, { accountId: 'account-id', mode: 'staging' }),
    async (prepared) => {
      const result = await readBuildOutput(prepared.directory);
      expect(result.workers.auxiliary.config.name).toBe('void-native-aux');
      expect(result.containers[0]?.config).toMatchObject({
        name: 'native-container',
        image: { reference: 'docker.io/example/native:1' },
      });
    },
  );
});

it.each(['../outside.js', '/outside.js', 'C:/outside.js', 'assets\\outside.js'])(
  'rejects a native manifest module outside its portable bundle: %s',
  async (module) => {
    const root = await nativeBuild();
    const path = getWorkerConfigPath(root);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.manifest = {
      type: 'complete',
      mainModule: 'index.js',
      modules: {
        'index.js': { type: 'esm' },
        [module]: { type: 'esm' },
      },
    };
    writeFileSync(path, JSON.stringify(config));
    await expect(prepareCfBuildOutput(root)).rejects.toThrow('inside the build bundle');
  },
);

it('rejects an absent native main module', async () => {
  const root = await nativeBuild();
  rmSync(join(getWorkerBundleDir(root), 'index.js'));
  await expect(prepareCfBuildOutput(root)).rejects.toThrow('main module');
});

function completeNativeManifest(root: string, modules: Record<string, { type: string }>): void {
  const path = getWorkerConfigPath(root);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.manifest = { type: 'complete', mainModule: 'index.js', modules };
  writeFileSync(path, JSON.stringify(config));
}

it('rejects a native main module that is not an ES module', async () => {
  const root = await nativeBuild();
  completeNativeManifest(root, { 'index.js': { type: 'text' } });
  await expect(prepareCfBuildOutput(root)).rejects.toThrow('must declare its main ES module');
});

it('names a declared native module that is missing from the bundle', async () => {
  const root = await nativeBuild();
  completeNativeManifest(root, { 'index.js': { type: 'esm' }, 'chunk.js': { type: 'esm' } });
  await expect(prepareCfBuildOutput(root)).rejects.toThrow(
    'Native Worker module chunk.js is missing from the build bundle.',
  );
});

it('names the expected inputs when a directory holds no Worker build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-build-output-empty-'));
  roots.push(root);
  await expect(prepareCfBuildOutput(root)).rejects.toThrow('No Cloudflare Worker build found');
});

it('returns only the public fields of the prepared output', async () => {
  const output = worker({ name: 'void-test', compatibility_date: '2026-09-29', main: 'index.js' });
  await withPrepared(prepareCfBuildOutput(output), async (prepared) => {
    expect(Object.keys(prepared).sort()).toEqual(['directory', 'dispose']);
  });
});

it.skipIf(process.platform === 'win32')(
  'rejects a legacy asset symlink outside the asset directory',
  async () => {
    const output = worker({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      assets: { directory: '../client' },
    });
    const client = join(dirname(output), 'client');
    const secret = join(dirname(output), 'secret.txt');
    mkdirSync(client, { recursive: true });
    writeFileSync(join(client, 'index.html'), '<p>ok</p>');
    writeFileSync(secret, 'private');
    symlinkSync(secret, join(client, 'leak.txt'));
    await expect(prepareCfBuildOutput(output)).rejects.toThrow(
      'symlink outside the asset directory',
    );
  },
);

it.skipIf(process.platform === 'win32')('rejects symlinked native modules', async () => {
  const root = await nativeBuild();
  symlinkSync('index.js', join(getWorkerBundleDir(root), 'alias.js'));
  await expect(prepareCfBuildOutput(root)).rejects.toThrow('Symlinks are not permitted');
});

it.skipIf(process.platform === 'win32')('rejects symlinked native assets', async () => {
  const root = await nativeBuild();
  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'private');
  symlinkSync(secret, join(getWorkerAssetsDir(root), 'leak.txt'));
  // The native reader refuses every symlink, so no link reaches the copied assets.
  await expect(prepareCfBuildOutput(root)).rejects.toThrow('Symlinks are not permitted');
});

it('preserves assets-only native output without adding a Worker bundle', async () => {
  const root = await nativeBuild();
  rmSync(getWorkerBundleDir(root), { recursive: true, force: true });
  await withPrepared(prepareCfBuildOutput(root), async (prepared) => {
    const output = await readBuildOutput(prepared.directory);
    expect(output.workers.default.bundleDir).toBeUndefined();
    expect(output.workers.default.config.manifest).toBeUndefined();
    expect(
      readFileSync(join(getWorkerAssetsDir(prepared.directory), 'index.html'), 'utf8'),
    ).toContain('native');
  });
});

it.each([undefined, 'account-id'])(
  'prepares public build output without credentials for built account %s',
  async (accountId) => {
    const config = {
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      ...(accountId ? { account_id: accountId } : {}),
    };
    const output = worker(config);
    const authored = readFileSync(join(output, 'wrangler.json'), 'utf8');
    const disposed = await withPrepared(prepareCfBuildOutput(output), async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.rootConfig.accountId).toBe(accountId);
      expect(built.rootConfig.buildContext).toEqual({ isPreview: false, mode: 'production' });
      expect(built.workers.default.config.manifest?.mainModule).toBe('index.js');
      expect(readFileSync(join(output, 'wrangler.json'), 'utf8')).toBe(authored);
    });
    expect(existsSync(disposed.directory)).toBe(false);
  },
);

it('records an explicit build mode and matching target account', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    account_id: 'account-id',
  });
  await withPrepared(
    prepareCfBuildOutput(output, { accountId: 'account-id', mode: 'staging' }),
    async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.rootConfig.accountId).toBe('account-id');
      expect(built.rootConfig.buildContext).toEqual({ isPreview: false, mode: 'staging' });
    },
  );
});

it('rejects a mismatching explicit target account', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    account_id: 'built-account',
  });
  await expect(
    prepareCfBuildOutput(output, { accountId: 'different-account' }),
  ).resolves.toBeNull();
});

it(
  'preserves additional module types from a real Cloudflare Vite build',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cf-additional-modules-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const configPath = join(root, 'wrangler.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'void-additional-modules',
        main: 'index.js',
        compatibility_date: '2026-09-29',
      }),
    );
    const assets = {
      'message.txt': 'hello',
      'page.html': '<p>hello</p>',
      'query.sql': 'SELECT 1',
      'bytes.bin': Buffer.from([1, 2, 3]),
      'module.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    };
    for (const [name, contents] of Object.entries(assets)) {
      writeFileSync(join(root, name), contents);
    }
    writeFileSync(join(root, 'style.css'), 'body { color: red; }');
    writeFileSync(
      join(root, 'index.js'),
      `import message from './message.txt';
import page from './page.html';
import query from './query.sql';
import bytes from './bytes.bin';
import wasm from './module.wasm';
import './style.css';
export default { fetch() {
  return Response.json({ message, page, query, bytes: Array.from(new Uint8Array(bytes)), imports: WebAssembly.Module.imports(wasm) });
} };`,
    );
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [cloudflare({ configPath })],
      build: { sourcemap: true },
    });
    await builder.buildApp();
    const output = join(root, 'dist', 'void_additional_modules');
    expect(
      readdirSync(output, { recursive: true }).some((name) => String(name).endsWith('.css')),
    ).toBe(true);
    await withPrepared(
      prepareCfBuildOutput(output, { accountId: 'account-id' }),
      async (prepared) => {
        const built = await readBuildOutput(prepared.directory);
        const manifest = built.workers.default.config.manifest!;
        expect(manifest.type).toBe('complete');
        expect(manifest.modules['index.js']).toEqual({ type: 'esm' });
        expect(manifest.modules['index.js.map']).toEqual({ type: 'sourcemap' });
        for (const [name, type] of Object.entries({
          message: 'text',
          page: 'text',
          query: 'text',
          bytes: 'data',
          module: 'wasm',
        })) {
          const moduleName = Object.keys(manifest.modules).find((path) =>
            path.startsWith(`assets/${name}-`),
          );
          expect(moduleName).toBeDefined();
          expect(manifest.modules[moduleName!]).toEqual({ type });
          expect(
            readFileSync(
              join(prepared.directory, '.cloudflare/output/v0/workers/default/bundle', moduleName!),
            ),
          ).toEqual(readFileSync(join(output, moduleName!)));
        }
        expect(manifest.modules['.vite/manifest.json']).toBeUndefined();
        expect(Object.keys(manifest.modules).some((name) => name.endsWith('.css'))).toBe(false);
        expectCfDryRun(prepared.directory);
      },
    );
  },
  CF_BUILD_TIMEOUT_MS,
);

it(
  'produces deployable cf build output without changing the authored project',
  async () => {
    const output = worker({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      send_metrics: false,
      keep_assets: true,
      vars: { MESSAGE: 'hello' },
      kv_namespaces: [{ binding: 'CACHE', id: 'namespace-id' }],
      d1_databases: [{ binding: 'DB', database_id: 'database-id', database_name: 'database' }],
      triggers: { crons: ['0 * * * *'] },
      assets: { binding: 'ASSETS', directory: '../client', run_worker_first: ['/**'] },
    });
    const client = join(dirname(output), 'client');
    mkdirSync(client);
    writeFileSync(join(client, 'index.html'), '<h1>hello</h1>');
    const disposed = await withPrepared(
      prepareCfBuildOutput(output, { accountId: 'account-id' }),
      async (prepared) => {
        const built = await readBuildOutput(prepared.directory);
        expect(built.rootConfig.accountId).toBe('account-id');
        expect(built.workers.default.config.env?.CACHE).toEqual({
          type: 'kv',
          id: 'namespace-id',
        });
        expect(built.workers.default.config.manifest?.mainModule).toBe('index.js');
        expect(built.workers.default.assetsDir).toBeDefined();
        expect(expectCfDryRun(prepared.directory).stdout).toContain('--dry-run: exiting now.');
      },
    );
    expect(existsSync(disposed.directory)).toBe(false);
    expect(existsSync(join(output, 'wrangler.json'))).toBe(true);
  },
  CF_BUILD_TIMEOUT_MS,
);

it(
  'bundles framework Worker output while honoring its public asset exclusions',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cf-framework-output-test-'));
    roots.push(root);
    const output = join(root, 'framework');
    mkdirSync(output);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(root, 'wrangler.json'),
      JSON.stringify({
        name: 'void-framework-test',
        account_id: 'account-id',
        main: 'framework/_worker.js',
        compatibility_date: '2026-09-29',
        assets: { directory: 'framework', binding: 'ASSETS', run_worker_first: true },
      }),
    );
    writeFileSync(
      join(output, '_worker.js'),
      "import app from './__original.js'; export default app;\n",
    );
    writeFileSync(
      join(output, '__original.js'),
      'export default { fetch() { return new Response("ok") } };\n',
    );
    writeFileSync(join(output, 'index.html'), '<h1>public</h1>');
    writeFileSync(join(output, '.assetsignore'), '_worker.js\n__original.js\n');

    await withPrepared(
      prepareCfFrameworkBuildOutput({
        projectRoot: root,
        configPath: join(root, 'wrangler.json'),
        accountId: 'account-id',
      }),
      async (prepared) => {
        const built = await readBuildOutput(prepared.directory);
        expect(built.workers.default.config.manifest?.mainModule).toBe('index.js');
        const assets = getWorkerAssetsDir(prepared.directory);
        expect(readFileSync(join(assets, 'index.html'), 'utf8')).toContain('public');
        expect(existsSync(join(assets, '_worker.js'))).toBe(false);
        expect(existsSync(join(assets, '__original.js'))).toBe(false);
        expect(existsSync(join(assets, '.assetsignore'))).toBe(false);
        expectCfDryRun(prepared.directory);
      },
    );
  },
  CF_BUILD_TIMEOUT_MS,
);

it(
  'accepts a nested hashed Worker entry with a relative module import',
  async () => {
    const output = worker({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: './assets/index-hash.js',
    });
    mkdirSync(join(output, 'assets'));
    writeFileSync(
      join(output, 'assets/index-hash.js'),
      "import { message } from './message.js'; export default { fetch() { return new Response(message) } };\n",
    );
    writeFileSync(join(output, 'assets/message.js'), 'export const message = "nested entry";\n');
    rmSync(join(output, 'index.js'));
    await withPrepared(
      prepareCfBuildOutput(output, { accountId: 'account-id' }),
      async (prepared) => {
        const built = await readBuildOutput(prepared.directory);
        expect(built.workers.default.config.manifest).toMatchObject({
          mainModule: 'assets/index-hash.js',
          modules: { 'assets/message.js': { type: 'esm' } },
        });
        expectCfDryRun(prepared.directory);
      },
    );
  },
  CF_BUILD_TIMEOUT_MS,
);

it.each(['../index.js', '/index.js', 'C:\\index.js'])(
  'rejects an out-of-bundle entry %s',
  async (main) => {
    const output = worker({ name: 'void-test', compatibility_date: '2026-09-29', main });
    await expect(prepareCfBuildOutput(output, { accountId: 'account-id' })).rejects.toThrow(
      'inside its output directory',
    );
  },
);

it('reports a missing built entry', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'assets/missing.js',
  });
  await expect(prepareCfBuildOutput(output, { accountId: 'account-id' })).rejects.toThrow(
    '"assets/missing.js" is missing',
  );
});

it('preserves binary font modules in a deployable Worker bundle', async () => {
  const output = worker({ name: 'void-test', compatibility_date: '2026-09-29', main: 'index.js' });
  mkdirSync(join(output, 'assets'));
  writeFileSync(
    join(output, 'index.js'),
    "import font from './assets/font.woff2'; export default { fetch() { return new Response(String(font.byteLength)) } };\n",
  );
  writeFileSync(join(output, 'assets/font.woff2'), Buffer.from([1, 2, 3]));
  await withPrepared(
    prepareCfBuildOutput(output, { accountId: 'account-id' }),
    async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.workers.default.config.manifest).toMatchObject({
        mainModule: 'index.js',
        modules: { 'assets/font.woff2': { type: 'data' } },
      });
    },
  );
});

it('names the file when a plugin emits an unsupported module', async () => {
  const output = worker({ name: 'void-test', compatibility_date: '2026-09-29', main: 'index.js' });
  writeFileSync(join(output, 'plugin.unknown'), 'unexpected');
  await expect(prepareCfBuildOutput(output, { accountId: 'account-id' })).rejects.toThrow(
    'unsupported module "plugin.unknown"',
  );
});

it('preserves limits and placement', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    limits: { cpu_ms: 100 },
    placement: { mode: 'smart' },
  });
  await withPrepared(
    prepareCfBuildOutput(output, { accountId: 'account-id' }),
    async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.workers.default.config.limits).toEqual({ cpuMs: 100 });
      expect(built.workers.default.config.placement).toEqual({ mode: 'smart' });
    },
  );
});

it(
  'preserves existing Worker variables, secrets, and assets in the cf upload',
  async () => {
    const output = worker({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      keep_vars: true,
      keep_secrets: true,
      keep_assets: true,
      vars: { EDITED: 'current' },
    });
    await withPrepared(
      prepareCfBuildOutput(output, { accountId: 'account-id' }),
      async (prepared) => {
        const built = await readBuildOutput(prepared.directory);
        expect(built.workers.default.config.env).toMatchObject({
          EDITED: { type: 'text', value: 'current' },
        });
        expect(built.workers.default.config.unsafe?.metadata).toMatchObject({
          keep_bindings: ['plain_text', 'json', 'secret_text', 'secret_key'],
          keep_assets: true,
        });
        expectCfDryRun(prepared.directory);
      },
    );
  },
  CF_BUILD_TIMEOUT_MS,
);

it('deploys Worker Workflow declarations through cf build output', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    workflows: [
      {
        binding: 'FLOW',
        name: 'void-test-flow',
        class_name: 'Flow',
        schedules: '0 * * * *',
        limits: { steps: 100 },
      },
    ],
  });
  writeFileSync(
    join(output, 'index.js'),
    'export class Flow { async run() {} }\nexport default { fetch() { return new Response("ok") } };\n',
  );
  await withPrepared(
    prepareCfBuildOutput(output, { accountId: 'account-id' }),
    async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.workers.default.config.env?.FLOW).toEqual({
        type: 'workflow',
        name: 'void-test-flow',
        worker: 'void-test',
        exportName: 'Flow',
      });
      expect(built.workers.default.config.exports?.Flow).toEqual({
        type: 'workflow',
        name: 'void-test-flow',
        schedules: '0 * * * *',
        limits: { steps: 100 },
      });
      expectCfDryRun(prepared.directory);
    },
  );
}, 15_000);

it('copies an internal symlinked Worker module into the prebuilt artifact', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
  });
  symlinkSync('index.js', join(output, 'chunk.js'));
  await withPrepared(
    prepareCfBuildOutput(output, { accountId: 'account-id' }),
    async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.workers.default.config.manifest?.modules['chunk.js']).toEqual({ type: 'esm' });
      expect(
        existsSync(
          join(prepared.directory, '.cloudflare/output/v0/workers/default/bundle/chunk.js'),
        ),
      ).toBe(true);
    },
  );
});

it('keeps Durable Objects, Queue triggers, and Containers in cf prebuilt output', async () => {
  const output = worker({
    name: 'void-test',
    compatibility_date: '2026-09-29',
    main: 'index.js',
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
    containers: [
      { name: 'counter-container', class_name: 'Counter', image: 'docker.io/example/counter:1' },
    ],
    queues: {
      producers: [{ binding: 'JOBS', queue: 'jobs' }],
      consumers: [{ queue: 'jobs', max_batch_size: 10 }],
    },
  });
  await withPrepared(
    prepareCfBuildOutput(output, { accountId: 'account-id' }),
    async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.workers.default.config.exports?.Counter).toEqual(
        expect.objectContaining({ type: 'durable-object', storage: 'sqlite' }),
      );
      expect(built.workers.default.config.env?.COUNTER).toEqual({
        type: 'unsafe:durable_object_namespace',
        class_name: 'Counter',
      });
      expect(built.workers.default.config.triggers).toContainEqual(
        expect.objectContaining({ type: 'queue', name: 'jobs' }),
      );
      expect(built.containers).toHaveLength(1);
      expectCfDryRun(prepared.directory);
    },
  );
}, 15_000);

it('bundles a generated static Worker and staged assets into prebuilt cf output', async () => {
  const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.tmp-cf-static-'));
  roots.push(root);
  const generated = join(root, '.void', 'deploy', 'cloudflare');
  const assets = join(generated, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<h1>static</h1>');
  writeFileSync(
    join(generated, 'static-edge.mjs'),
    renderCloudflareStaticEntry({
      runtimeImport: 'void/edge',
      headerRules: [],
      redirectRules: [],
      fallbackRules: [],
    }),
  );
  const configPath = join(generated, 'wrangler-static.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'void-static-test',
      account_id: 'account-id',
      compatibility_date: '2026-09-29',
      main: 'static-edge.mjs',
      workers_dev: true,
      assets: {
        binding: 'ASSETS',
        directory: './assets',
        run_worker_first: true,
        not_found_handling: 'single-page-application',
      },
    }),
  );
  await withPrepared(
    prepareCfStaticBuildOutput({
      projectRoot: root,
      configPath,
      assetsDirectory: assets,
      accountId: 'account-id',
    }),
    async (prepared) => {
      const built = await readBuildOutput(prepared.directory);
      expect(built.workers.default.config.manifest?.mainModule).toBe('index.js');
      expect(built.workers.default.assetsDir).toBeDefined();
      expect(prepared.assetsDirectory).toBe(toSlash(assets));
      expectCfDryRun(prepared.directory, ['deploy']);
    },
  );
});

it.skipIf(process.platform === 'win32')(
  'builds a named Sandbox image into cf prebuilt output and cleans up its local tag',
  async () => {
    const output = worker({
      name: 'void-sandbox-test',
      main: 'index.js',
      compatibility_date: '2026-09-30',
      durable_objects: { bindings: [{ name: 'SANDBOX', class_name: 'Sandbox' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }],
      containers: [
        {
          name: 'void-sandbox-v1',
          class_name: 'Sandbox',
          scheduling_policy: 'durable_object',
          images: {
            default: {
              dockerfile: join(tmpdir(), 'Dockerfile'),
              build_context: tmpdir(),
            },
          },
        },
      ],
    });
    const log = join(dirname(output), 'docker.log');
    const binary = join(dirname(output), 'docker-stub');
    writeFileSync(
      binary,
      '#!/usr/bin/env node\n' +
        'require("node:fs").appendFileSync(' +
        JSON.stringify(log) +
        ', JSON.stringify(process.argv.slice(2)) + "\\n");\n',
    );
    chmodSync(binary, 0o755);
    vi.stubEnv('WRANGLER_DOCKER_BIN', binary);
    let tag: string;
    await withPrepared(
      prepareCfBuildOutput(output, { accountId: 'account-id' }),
      async (prepared) => {
        const built = await readBuildOutput(prepared.directory);
        const container = built.containers[0]!.config;
        expect(container.schedulingPolicy).toBe('durable-object');
        if (container.schedulingPolicy !== 'durable-object') {
          throw new Error('Expected a managed container');
        }
        const image = container.images?.default;
        if (!image || !('localReference' in image)) {
          throw new Error('Expected a prepared local image');
        }
        expect(Object.keys(image)).toEqual(['localReference']);
        expect(image.localReference.startsWith('void-sandbox-build:')).toBe(true);
        tag = image.localReference;
        expectCfDryRun(prepared.directory);
      },
    );
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls[0]).toEqual([
      'build',
      '--platform',
      'linux/amd64',
      '--file',
      join(tmpdir(), 'Dockerfile'),
      '--tag',
      tag!,
      tmpdir(),
    ]);
    expect(calls.at(-1)).toEqual(['image', 'rm', tag!]);
  },
  CF_BUILD_TIMEOUT_MS,
);

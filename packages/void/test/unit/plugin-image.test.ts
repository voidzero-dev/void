import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigEnv, EnvironmentOptions, ResolvedConfig, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveImageConfig, toClientImageConfig } from '../../src/image-config.ts';
import { IMAGE_REGISTRY_KEY } from '../../src/image/config.ts';
import { getImageConfig } from '../../src/image/index.ts';
import {
  generateImageConfigModule,
  imagePlugin,
  resolveImageConfigForCommand,
  shouldMountImageOptimizer,
  type ImagePluginOptions,
} from '../../src/plugin-image.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const tempDirs: Array<string> = [];
const PNG_FIXTURE = fileURLToPath(new URL('../fixtures/images/test.png', import.meta.url));
const IMAGE_ENTRY = fileURLToPath(import.meta.resolve('#self/image'));

const SERVE: ConfigEnv = { command: 'serve', mode: 'development' };
const BUILD: ConfigEnv = { command: 'build', mode: 'production' };
const PREVIEW: ConfigEnv = { command: 'serve', mode: 'production', isPreview: true };

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-image-plugin-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function createPlugin(root: string, options: Partial<ImagePluginOptions> = {}) {
  return imagePlugin(root, { images: undefined, configFile: 'void.config.ts', ...options });
}

type ImagePlugin = ReturnType<typeof createPlugin>;

function runConfig(plugin: ImagePlugin, env: ConfigEnv): void {
  (getHookHandler(plugin.config) as (config: UserConfig, env: ConfigEnv) => void)({}, env);
}

type LoadContext = {
  environment?: { config: { consumer: 'client' | 'server' } };
  error(message: string): never;
  addWatchFile(file: string): void;
};

function loadContext(consumer: 'client' | 'server' = 'client', watched: Array<string> = []) {
  return {
    environment: { config: { consumer } },
    error(message: string): never {
      throw new Error(message);
    },
    addWatchFile(file: string) {
      watched.push(file);
    },
  } satisfies LoadContext;
}

function load(plugin: ImagePlugin, id: string, context: LoadContext = loadContext()) {
  return (
    getHookHandler(plugin.load) as (this: LoadContext, id: string) => string | undefined
  ).call(context, id);
}

function transform(plugin: ImagePlugin, code: string, id: string) {
  return (
    getHookHandler(plugin.transform) as (
      code: string,
      id: string,
    ) => { code: string; map: unknown } | undefined
  )(code, id);
}

function configEnvironment(plugin: ImagePlugin, name: string, options: EnvironmentOptions) {
  return (
    getHookHandler(plugin.configEnvironment) as (
      name: string,
      options: EnvironmentOptions,
    ) => EnvironmentOptions | undefined
  )(name, options);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  delete (globalThis as Record<PropertyKey, unknown>)[IMAGE_REGISTRY_KEY];
  vi.unstubAllEnvs();
});

describe('resolveImageConfigForCommand', () => {
  const root = '/project';

  it.each([
    ['dev', SERVE, true],
    ['build', BUILD, false],
    ['preview', PREVIEW, false],
  ] as const)('resolves %s with dev: %s', (_name, env, dev) => {
    const resolved = resolveImageConfigForCommand(root, { configFile: 'void.config.ts' }, env);
    expect(resolved.dev).toBe(dev);
    expect(resolved.unoptimized).toBe(false);
  });

  it.each([
    ['target: "node"', { target: 'node' as const }],
    ['target: "bun"', { target: 'bun' as const }],
    ['output: "static"', { output: 'static' as const }],
  ])('resolves %s as unoptimized', (_name, options) => {
    const resolved = resolveImageConfigForCommand(
      root,
      { configFile: 'void.config.ts', ...options },
      BUILD,
    );
    expect(resolved.unoptimized).toBe(true);
  });

  it('resolves Void Platform builds of Cloudflare apps as unoptimized', () => {
    vi.stubEnv('VOID_DEPLOY_PROJECT_ID', 'proj_1');
    const options = { configFile: 'void.config.ts' };
    expect(resolveImageConfigForCommand(root, options, BUILD).unoptimized).toBe(true);
    expect(resolveImageConfigForCommand(root, options, SERVE).unoptimized).toBe(false);
    expect(
      resolveImageConfigForCommand(root, { ...options, images: { loader: 'cloudflare' } }, BUILD)
        .unoptimized,
    ).toBe(false);
  });

  it('names the config file in loader, path and loaderFile errors', () => {
    expect(() =>
      resolveImageConfigForCommand(
        root,
        { configFile: 'void.config.ts', images: { loader: 'imgix' } },
        BUILD,
      ),
    ).toThrow(
      'config: Invalid "images" in void.config.ts. Specified images.loader property (imgix) also requires images.path property to be assigned to a URL prefix.',
    );
    expect(() =>
      resolveImageConfigForCommand(
        createRoot(),
        { configFile: 'void.json', images: { loaderFile: './missing-loader.ts' } },
        SERVE,
      ),
    ).toThrow(
      /^config: Invalid "images" in void\.json\. Specified images\.loaderFile does not exist/,
    );
  });
});

describe('shouldMountImageOptimizer', () => {
  const active = resolveImageConfig(undefined, { root: '/project', dev: false });
  const unoptimized = resolveImageConfig({ unoptimized: true }, { root: '/project', dev: false });
  const cloudflare = resolveImageConfig({ loader: 'cloudflare' }, { root: '/project', dev: false });

  it.each([
    ['Image usage', active, { nodeTarget: false, usesImageOptimizer: true }, true],
    [
      'inference.bindings.images: true',
      active,
      { nodeTarget: false, usesImageOptimizer: false, inferenceBinding: true },
      true,
    ],
    [
      'a custom binding name',
      active,
      { nodeTarget: false, usesImageOptimizer: undefined, inferenceBinding: 'PHOTOS' },
      true,
    ],
    ['no Image usage', active, { nodeTarget: false, usesImageOptimizer: false }, false],
    [
      'inference.bindings.images: false',
      active,
      { nodeTarget: false, usesImageOptimizer: false, inferenceBinding: false },
      false,
    ],
    ['a node target', active, { nodeTarget: true, usesImageOptimizer: true }, false],
    ['unoptimized', unoptimized, { nodeTarget: false, usesImageOptimizer: true }, false],
    ['the cloudflare loader', cloudflare, { nodeTarget: false, usesImageOptimizer: true }, false],
  ] as const)('%s → %s', (_name, resolved, options, expected) => {
    expect(shouldMountImageOptimizer(resolved, options)).toBe(expected);
  });
});

describe('imagePlugin config module', () => {
  it('registers the client config for the browser and the full patterns for servers', () => {
    const plugin = createPlugin('/project', {
      images: { remotePatterns: [{ hostname: 'cdn.example.com' }], qualities: [50, 75] },
    });
    runConfig(plugin, BUILD);
    const resolved = plugin.api.getConfig()!;

    const client = load(plugin, '\0virtual:void/image-config', loadContext('client'))!;
    const server = load(plugin, '\0virtual:void/image-config', loadContext('server'))!;

    expect(client).toBe(generateImageConfigModule(resolved, 'client'));
    expect(client).not.toContain('remotePatterns');
    expect(client).not.toContain('import ');
    expect(client).toContain('globalThis[Symbol.for("void.image.config.v1")] = { config: ');
    expect(client).toContain('loader: undefined };');
    expect(server).toContain('"remotePatterns":[{"hostname":"cdn.example.com"');

    // The registration is what `void/image` reads.
    // oxlint-disable-next-line no-new-func -- evaluates the generated module without imports
    new Function(client)();
    expect(getImageConfig()).toEqual(toClientImageConfig(resolved, 'client'));
    expect(getImageConfig().qualities).toEqual([50, 75]);
  });

  it('keeps patterns in development client bundles', () => {
    const plugin = createPlugin('/project');
    runConfig(plugin, SERVE);
    const client = load(plugin, '\0virtual:void/image-config', loadContext('client'))!;
    expect(client).toContain('"localPatterns":[');
    expect(client).toContain('"dev":true');
  });

  it('imports the loaderFile default export by absolute path', () => {
    const root = createRoot();
    writeFileSync(join(root, 'image-loader.ts'), 'export default ({ src }) => src;\n');
    const plugin = createPlugin(root, {
      images: { loader: 'custom', loaderFile: './image-loader.ts' },
    });
    runConfig(plugin, BUILD);

    const code = load(plugin, '\0virtual:void/image-config', loadContext('client'))!;
    const loaderPath = plugin.api.getConfig()!.loaderFile;

    expect(loaderPath).toMatch(/\/image-loader\.ts$/);
    expect(code.split('\n')[0]).toBe(
      `import __voidImageLoader from ${JSON.stringify(loaderPath)};`,
    );
    expect(code).toContain('loader: __voidImageLoader };');
    expect(code).toContain('"loader":"custom"');
  });

  it('resolves the virtual module id', () => {
    const plugin = createPlugin('/project');
    const resolveId = getHookHandler(plugin.resolveId) as (id: string) => string | undefined;
    expect(resolveId('virtual:void/image-config')).toBe('\0virtual:void/image-config');
  });

  it('caches the config per command and exposes the mounted config', () => {
    const plugin = createPlugin('/project', { inferenceBinding: undefined });
    expect(plugin.api.getConfig()).toBeUndefined();
    expect(plugin.api.getMountedConfig(true)).toBeUndefined();

    const build = plugin.api.resolve(BUILD);
    expect(plugin.api.resolve(BUILD)).toBe(build);
    expect(plugin.api.getMountedConfig(true)).toBe(build);
    expect(plugin.api.getMountedConfig(false)).toBeUndefined();

    runConfig(plugin, SERVE);
    expect(plugin.api.getConfig()?.dev).toBe(true);
  });

  it('mounts nothing for node targets or static output', () => {
    for (const options of [{ target: 'node' as const }, { output: 'static' as const }]) {
      const plugin = createPlugin('/project', options);
      runConfig(plugin, BUILD);
      expect(plugin.api.getConfig()?.unoptimized).toBe(true);
      expect(plugin.api.getMountedConfig(true)).toBeUndefined();
    }
  });
});

describe('imagePlugin void/image injection', () => {
  const code = 'export const value = 1;\n';
  const injected = 'import "virtual:void/image-config";\nexport const value = 1;\n';

  it.each([
    ['the resolved entry', IMAGE_ENTRY],
    ['the entry with a version query', `${IMAGE_ENTRY}?v=1a2b3c`],
  ])('prepends the config import to %s', (_name, id) => {
    const plugin = createPlugin('/project');
    expect(transform(plugin, code, id)?.code).toBe(injected);
  });

  it('matches the entry through a symlinked package directory', () => {
    const root = createRoot();
    const linked = join(root, 'node_modules-void');
    symlinkSync(join(IMAGE_ENTRY, '..', '..', '..'), linked, 'dir');
    const plugin = createPlugin(root);
    expect(transform(plugin, code, join(linked, 'dist', 'image', 'index.mjs'))?.code).toBe(
      injected,
    );
  });

  it('leaves other modules alone', () => {
    const root = createRoot();
    writeFileSync(join(root, 'src', 'index.mjs'), code);
    const plugin = createPlugin(root);
    expect(transform(plugin, code, join(root, 'src', 'index.mjs'))).toBeUndefined();
    expect(transform(plugin, code, join(IMAGE_ENTRY, '..', '..', 'runtime', 'index.mjs'))).toBe(
      undefined,
    );
  });

  it('excludes void/image from client dependency optimization only', () => {
    const plugin = createPlugin('/project');
    expect(configEnvironment(plugin, 'client', {})).toEqual({
      optimizeDeps: { exclude: ['void/image'] },
    });
    expect(configEnvironment(plugin, 'islands', { consumer: 'client' })).toEqual({
      optimizeDeps: { exclude: ['void/image'] },
    });
    expect(configEnvironment(plugin, 'ssr', {})).toBeUndefined();
    expect(configEnvironment(plugin, 'void_worker', { consumer: 'server' })).toBeUndefined();
  });
});

describe('imagePlugin ?image imports', () => {
  function setup() {
    const root = createRoot();
    const plugin = createPlugin(root);
    (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
      root,
    } as ResolvedConfig);
    return { root, plugin };
  }

  it('returns the asset URL with the intrinsic size and records the source', () => {
    const { root, plugin } = setup();
    const file = join(root, 'src', 'hero.png');
    copyFileSync(PNG_FIXTURE, file);
    const watched: Array<string> = [];

    const code = load(plugin, `${file}?image`, loadContext('server', watched));

    expect(code).toBe(
      `import src from ${JSON.stringify(file)};\nexport default { src, width: 100, height: 50 };\n`,
    );
    expect(watched).toEqual([file]);
    expect([...plugin.api.imageSources]).toEqual(['src/hero.png']);
    expect(load(plugin, `${file}?import&image`)).toBe(code);
  });

  it('imports types Vite does not treat as assets with ?url', () => {
    const { root, plugin } = setup();
    const file = join(root, 'src', 'photo.heic');
    const ispe = [0, 0, 0, 20, ...Buffer.from('ispe'), 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 6];
    const ipco = [0, 0, 0, 8 + ispe.length, ...Buffer.from('ipco'), ...ispe];
    const iprp = [0, 0, 0, 8 + ipco.length, ...Buffer.from('iprp'), ...ipco];
    const meta = [0, 0, 0, 12 + iprp.length, ...Buffer.from('meta'), 0, 0, 0, 0, ...iprp];
    const ftyp = [0, 0, 0, 16, ...Buffer.from('ftypheic'), 0, 0, 0, 0];
    writeFileSync(file, new Uint8Array([...ftyp, ...meta]));

    expect(load(plugin, `${file}?image`)).toBe(
      `import src from ${JSON.stringify(`${file}?url`)};\nexport default { src, width: 8, height: 6 };\n`,
    );
  });

  it('fails with the file name when the size cannot be read', () => {
    const { root, plugin } = setup();
    writeFileSync(join(root, 'src', 'notes.png'), 'not an image');

    expect(() => load(plugin, `${join(root, 'src', 'notes.png')}?image`)).toThrow(
      'Could not read the dimensions of "src/notes.png" imported with "?image". Supported formats: PNG, JPEG, GIF, WebP, AVIF, HEIC, SVG, BMP and ICO.',
    );
    expect(() => load(plugin, `${join(root, 'src', 'missing.png')}?image`)).toThrow(
      /^Could not read "src\/missing\.png" imported with "\?image": ENOENT/,
    );
    expect(plugin.api.imageSources.size).toBe(0);
  });

  it('ignores ids without the image query', () => {
    const { root, plugin } = setup();
    expect(load(plugin, join(root, 'src', 'hero.png'))).toBeUndefined();
    expect(load(plugin, `${join(root, 'src', 'hero.png')}?imagery`)).toBeUndefined();
  });
});

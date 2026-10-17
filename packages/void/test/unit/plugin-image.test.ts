import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createServer,
  type ConfigEnv,
  type EnvironmentOptions,
  type ResolvedConfig,
  type UserConfig,
} from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveImageConfig, toClientImageConfig } from '../../src/image-config.ts';
import { IMAGE_REGISTRY_KEY, type ResolvedImageConfig } from '../../src/image/config.ts';
import { getImageConfig, getImageProps } from '../../src/image/index.ts';
import { validateImageParams } from '../../src/image/optimizer/validate.ts';
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
  ])('resolves %s without an optimizer', (_name, options) => {
    const resolved = resolveImageConfigForCommand(
      root,
      { configFile: 'void.config.ts', ...options },
      BUILD,
    );
    expect(resolved.noOptimizer).toBe(true);
    expect(resolved.unoptimized).toBe(false);
  });

  it('resolves Void Platform builds of Cloudflare apps without an optimizer', () => {
    vi.stubEnv('VOID_DEPLOY_PROJECT_ID', 'proj_1');
    const options = { configFile: 'void.config.ts' };
    expect(resolveImageConfigForCommand(root, options, BUILD).noOptimizer).toBe(true);
    expect(resolveImageConfigForCommand(root, options, SERVE).noOptimizer).toBe(false);
    expect(
      resolveImageConfigForCommand(root, { ...options, images: { loader: 'cloudflare' } }, BUILD)
        .noOptimizer,
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

  it('imports the loaderFile module by absolute path', () => {
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
      `import * as __voidImageLoaderModule from ${JSON.stringify(loaderPath)};`,
    );
    expect(code).toContain(
      'loader: Reflect.get(__voidImageLoaderModule, "default"), hasLoaderFile: true };',
    );
    expect(code).toContain('"loader":"custom"');
  });

  it('registers a loaderFile without a default export so Image reports it', () => {
    const root = createRoot();
    writeFileSync(join(root, 'image-loader.ts'), 'export function loader() {}\n');
    const plugin = createPlugin(root, { images: { loaderFile: './image-loader.ts' } });
    runConfig(plugin, BUILD);
    const code = load(plugin, '\0virtual:void/image-config', loadContext('server'))!;
    const body = code.split('\n').slice(1).join('\n');

    // oxlint-disable-next-line no-new-func -- evaluates the module with a namespace lacking `default`
    new Function('__voidImageLoaderModule', body)({ loader() {} });
    expect(() => getImageProps({ src: '/a.png', alt: '', width: 10, height: 10 })).toThrow(
      'images.loaderFile detected but the file is missing default export.',
    );
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
      expect(plugin.api.getConfig()?.noOptimizer).toBe(true);
      expect(plugin.api.getMountedConfig(true)).toBeUndefined();
    }
  });

  it('mounts an absolute images.path at its pathname and keeps the URL for Image', () => {
    const path = 'https://cdn.example.com/_void/image';
    const plugin = createPlugin('/project', { images: { path } });
    runConfig(plugin, BUILD);

    expect(plugin.api.getConfig()?.path).toBe(path);
    expect(plugin.api.getMountedConfig(true)?.path).toBe('/_void/image');
    expect(plugin.api.getMountedConfig(false)).toBeUndefined();
    expect(load(plugin, '\0virtual:void/image-config')).toContain(`"path":"${path}"`);
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

  it('keeps dev imports allowed by user localPatterns through their /@fs/ URL', () => {
    const root = createRoot();
    const file = join(root, 'src', 'hero.png').replaceAll('\\', '/');
    copyFileSync(PNG_FIXTURE, file);
    const images = { localPatterns: [{ pathname: '/photos/**', search: '' }] };
    const plugin = createPlugin(root, { images });
    (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
      root,
    } as ResolvedConfig);
    runConfig(plugin, SERVE);
    const src = `/@fs/${file.replace(/^\/+/, '')}`;

    expect(load(plugin, `${file}?image`)).toBe(
      `import ${JSON.stringify(file)};\nexport default { src: ${JSON.stringify(src)}, width: 100, height: 50 };\n`,
    );
    const resolved = plugin.api.getConfig()!;
    (globalThis as Record<PropertyKey, unknown>)[IMAGE_REGISTRY_KEY] = {
      config: toClientImageConfig(resolved, 'client'),
      loader: undefined,
    };
    // Vite's own dev URL for the file is its source path, which the patterns do not list.
    expect(() => getImageProps({ src: '/src/hero.png', alt: '', width: 100, height: 50 })).toThrow(
      'does not match `images.localPatterns`',
    );
    expect(getImageProps({ src: { src, width: 100, height: 50 }, alt: '' }).props.src).toBe(
      `/_void/image?url=${encodeURIComponent(src)}&w=256&q=75`,
    );
    expect(
      validateImageParams(new URLSearchParams({ url: src, w: '256', q: '75' }), resolved),
    ).not.toHaveProperty('errorMessage');
  });

  it('allows built ?image imports under a custom build.assetsDir', () => {
    const images = { localPatterns: [{ pathname: '/photos/**', search: '' }] };
    const configResolved = (plugin: ImagePlugin) =>
      (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
        root: '/project',
        build: { assetsDir: 'static' },
      } as ResolvedConfig);
    const allowed = (resolved: ResolvedImageConfig, url: string) =>
      !(
        'errorMessage' in
        validateImageParams(new URLSearchParams({ url, w: '256', q: '75' }), resolved)
      );

    // Vite resolves its config after the `config` hook resolved `images`.
    const plugin = createPlugin('/project', { images });
    runConfig(plugin, BUILD);
    configResolved(plugin);
    const resolved: ResolvedImageConfig = plugin.api.getMountedConfig(true)!;
    expect(resolved.localPatterns.map((p) => p.pathname)).toEqual(['/photos/**', '/static/**']);
    expect(allowed(resolved, '/static/hero-CE0Ev3M-.png')).toBe(true);
    expect(allowed(resolved, '/assets/hero-CE0Ev3M-.png')).toBe(false);
    expect(load(plugin, '\0virtual:void/image-config', loadContext('server'))).toContain(
      '"pathname":"/static/**"',
    );

    // A command resolved after Vite's config uses it too.
    const preview: ResolvedImageConfig = plugin.api.resolve(PREVIEW);
    expect(preview.localPatterns.map((p) => p.pathname)).toEqual(['/photos/**', '/static/**']);
  });

  it('keeps Vite URLs for builds and for dev without user localPatterns', () => {
    const root = createRoot();
    const file = join(root, 'src', 'hero.png').replaceAll('\\', '/');
    copyFileSync(PNG_FIXTURE, file);
    const viteUrl = `import src from ${JSON.stringify(file)};\nexport default { src, width: 100, height: 50 };\n`;
    const images = { localPatterns: [{ pathname: '/photos/**', search: '' }] };
    const options = { images, configFile: 'void.config.ts' };

    for (const [pluginOptions, env] of [
      [{ images }, BUILD],
      [{ images }, PREVIEW],
      [{}, SERVE],
      [{ images: { ...images, unoptimized: true } }, SERVE],
    ] as const) {
      const plugin = createPlugin(root, pluginOptions);
      (getHookHandler(plugin.configResolved) as (config: ResolvedConfig) => void)({
        root,
      } as ResolvedConfig);
      runConfig(plugin, env);
      expect(load(plugin, `${file}?image`)).toBe(viteUrl);
    }
    expect(
      resolveImageConfigForCommand(root, options, BUILD).localPatterns.map((p) => p.pathname),
    ).toEqual(['/photos/**', '/assets/**']);
    expect(
      resolveImageConfigForCommand(root, options, SERVE).localPatterns.map((p) => p.pathname),
    ).toEqual(['/photos/**', '/assets/**', '/@fs/**']);
  });
});

describe('imagePlugin ?image imports on the dev server', () => {
  it('keeps files outside server.fs.allow private', async () => {
    const base = realpathSync(createRoot());
    const root = join(base, 'app');
    const outside = join(base, 'outside');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(outside);
    const secret = join(outside, 'secret.png').replaceAll('\\', '/');
    const shared = join(outside, 'shared.png').replaceAll('\\', '/');
    copyFileSync(PNG_FIXTURE, secret);
    copyFileSync(PNG_FIXTURE, shared);
    writeFileSync(
      join(root, 'src', 'main.js'),
      `import hero from ${JSON.stringify(`${shared}?image`)};\nexport default hero;\n`,
    );
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: {
        host: '127.0.0.1',
        port: 0,
        ws: false,
        preTransformRequests: false,
        fs: { strict: true, allow: [root] },
      },
      plugins: [createPlugin(root)],
    });
    try {
      await server.listen();
      const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
      const get = async (path: string) => {
        const response = await fetch(origin + path);
        return { status: response.status, body: await response.text() };
      };

      expect((await get(`/@fs${secret}`)).status).toBe(403);
      const probe = await get(`/@fs${secret}?image&import`);
      expect(probe.status).toBe(403);
      expect(probe.body).not.toContain('width');
      expect((await get(`/@fs${secret}`)).status).toBe(403);

      // An import from the app still loads a file outside the allow list.
      const main = await server.environments.client.transformRequest('/src/main.js');
      expect(main?.code).toContain(`"/@fs${shared}?import&image"`);
      const image = await get(`/@fs${shared}?import&image`);
      expect(image.status).toBe(200);
      expect(image.body).toContain('width: 100, height: 50');
    } finally {
      await server.close();
    }
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { resolveImagesBindingName, shouldBindImages } from '../../src/plugin-binding-utils.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

type MockCloudflarePlugin = Plugin & {
  api: {
    pluginConfig: MockCloudflarePluginConfig;
  };
};

vi.mock('@cloudflare/vite-plugin', () => import('../helpers/cloudflare-vite-plugin.ts'));

const tempDirs: Array<string> = [];

const IMAGE_COMPONENT = `
import { Image } from "@void/react";

export function Hero() {
  return <Image src="/hero.png" alt="" width={640} height={320} />;
}
`;

const IMAGES_ENV_READ = `
export const POST = defineHandler(async (c) => {
  const info = await c.env.IMAGES.info(c.req.raw.body);
  return Response.json(info);
});
`;

function createProjectRoot(
  voidConfig: Record<string, unknown> = {},
  sources: Record<string, string> = { 'src/components/Hero.tsx': IMAGE_COMPONENT },
): string {
  const root = mkdtempSync(join(tmpdir(), 'void-images-config-'));
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

async function resolveCloudflareConfig(
  root: string,
  resolved: Record<string, unknown>,
  configEnv: import('vite').ConfigEnv,
): Promise<Record<string, unknown>> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);

  const { voidPlugin } = await import('../../src/index.ts');
  const plugins = voidPlugin();

  const envPlugin = plugins.find((plugin) => plugin.name === 'void:env');
  const config = getHookHandler(envPlugin?.config) as (
    config: import('vite').UserConfig,
    env: import('vite').ConfigEnv,
  ) => void;
  config({}, configEnv);

  const cloudflarePlugin = plugins.find(
    (plugin): plugin is MockCloudflarePlugin => plugin.name === 'mock:cloudflare',
  );
  if (!cloudflarePlugin) {
    throw new Error('Expected mocked Cloudflare plugin.');
  }

  return cloudflarePlugin.api.pluginConfig.config(resolved);
}

const SERVE: import('vite').ConfigEnv = { command: 'serve', mode: 'development' };
const BUILD: import('vite').ConfigEnv = { command: 'build', mode: 'production' };

function imagesVar(result: Record<string, unknown>): string | undefined {
  return (result.vars as Record<string, string> | undefined)?.__VOID_IMAGES_BINDING;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('mergeBindings images config', () => {
  it.each([
    ['serve', SERVE],
    ['build', BUILD],
  ] as const)('binds IMAGES for Image usage on %s without remote mode', async (_name, env) => {
    const root = createProjectRoot();

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, env);

    expect(result.images).toEqual({ binding: 'IMAGES' });
    expect(imagesVar(result)).toBeUndefined();
  });

  it('binds IMAGES for getImageProps from void/image', async () => {
    const root = createProjectRoot(
      {},
      {
        'routes/api/og.ts': `
import { getImageProps } from "void/image";
export const GET = () => Response.json(getImageProps({ src: "/a.png", alt: "", width: 64, height: 64 }).props);
`,
      },
    );

    const result = await resolveCloudflareConfig(root, {}, BUILD);

    expect(result.images).toEqual({ binding: 'IMAGES' });
  });

  it('binds IMAGES for an env.IMAGES read without Image usage', async () => {
    const root = createProjectRoot({}, { 'routes/api/thumb.ts': IMAGES_ENV_READ });

    const result = await resolveCloudflareConfig(root, {}, BUILD);

    expect(result.images).toEqual({ binding: 'IMAGES' });
    expect(imagesVar(result)).toBeUndefined();
  });

  it('uses a custom inference.bindings.images name and passes it to the runtime', async () => {
    const root = createProjectRoot({ inference: { bindings: { images: 'PHOTOS' } } });

    const result = await resolveCloudflareConfig(root, {}, BUILD);

    expect(result.images).toEqual({ binding: 'PHOTOS' });
    expect(imagesVar(result)).toBe('PHOTOS');
  });

  it('preserves an authored root images binding', async () => {
    const root = createProjectRoot({ inference: { bindings: { images: 'PHOTOS' } } });
    const resolved = { images: { binding: 'MEDIA' } };

    const result = await resolveCloudflareConfig(root, resolved, BUILD);

    expect(resolved.images).toEqual({ binding: 'MEDIA' });
    expect('images' in result).toBe(false);
    expect(imagesVar(result)).toBe('MEDIA');
  });

  it('needs no runtime variable for an authored root IMAGES binding', async () => {
    const root = createProjectRoot();

    const result = await resolveCloudflareConfig(root, { images: { binding: 'IMAGES' } }, SERVE);

    expect('images' in result).toBe(false);
    expect(imagesVar(result)).toBeUndefined();
  });

  it('rejects Image usage when another binding already uses the name', async () => {
    const root = createProjectRoot();

    await expect(
      resolveCloudflareConfig(
        root,
        { r2_buckets: [{ binding: 'IMAGES', bucket_name: 'b' }] },
        BUILD,
      ),
    ).rejects.toThrow(
      `images: the Cloudflare Images binding 'IMAGES' conflicts with the R2 Bucket binding of the same name. Set "inference.bindings.images" in void.config.ts to another binding name, or to false to serve original images.`,
    );
  });

  it('rejects a custom name that collides with a binding Void adds', async () => {
    const root = createProjectRoot({
      inference: { bindings: { images: 'STORAGE', storage: true } },
    });

    await expect(resolveCloudflareConfig(root, {}, BUILD)).rejects.toThrow(
      "images: the Cloudflare Images binding 'STORAGE' conflicts with the R2 Bucket binding",
    );
  });

  it('binds a renamed Images binding beside a colliding user binding', async () => {
    const root = createProjectRoot({ inference: { bindings: { images: 'CF_IMAGES' } } });
    const resolved = { r2_buckets: [{ binding: 'IMAGES', bucket_name: 'b' }] };

    const result = await resolveCloudflareConfig(root, resolved, BUILD);

    expect(result.images).toEqual({ binding: 'CF_IMAGES' });
    expect(imagesVar(result)).toBe('CF_IMAGES');
  });

  it('leaves a user binding named IMAGES alone when only env.IMAGES reads it', async () => {
    const root = createProjectRoot({}, { 'routes/api/thumb.ts': IMAGES_ENV_READ });
    const resolved = { r2_buckets: [{ binding: 'IMAGES', bucket_name: 'b' }] };

    const result = await resolveCloudflareConfig(root, resolved, BUILD);

    expect('images' in result).toBe(false);
    expect(imagesVar(result)).toBeUndefined();
  });
});

// Root AGENTS.md: an app that does not use the feature emits no binding, so native
// deploys stay Workers Free-compatible by default.
describe('mergeBindings images config without the optimizer', () => {
  it.each<[string, Record<string, unknown>, Record<string, string> | undefined]>([
    ['never renders Image', {}, { 'src/components/Hero.tsx': 'export const Hero = () => null;' }],
    [
      'imports only Link and image types',
      {},
      {
        'src/components/Nav.tsx':
          'import { Link, type ImageProps } from "@void/react"; export const Nav = () => <Link href="/" />;',
      },
    ],
    ['sets images.unoptimized', { images: { unoptimized: true } }, undefined],
    ['uses a custom loader', { images: { loader: 'custom' } }, undefined],
    ['uses the cloudflare loader', { images: { loader: 'cloudflare' } }, undefined],
    ['sets images.loaderFile', { images: { loaderFile: './image-loader.ts' } }, undefined],
    [
      'sets inference.bindings.images to false',
      { inference: { bindings: { images: false } } },
      undefined,
    ],
    ['builds static output', { output: 'static' }, undefined],
  ])('emits no images binding or variable when the app %s', async (_name, voidConfig, sources) => {
    const root = createProjectRoot(
      voidConfig,
      sources ?? {
        'src/components/Hero.tsx': IMAGE_COMPONENT,
        'image-loader.ts': 'export default ({ src, width }) => `${src}?w=${width}`;',
      },
    );

    for (const env of [SERVE, BUILD]) {
      vi.resetModules();
      const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, env);

      expect('images' in result).toBe(false);
      expect(imagesVar(result)).toBeUndefined();
    }
  });
});

describe('Images binding helpers', () => {
  it('prefers a root binding over the configured name', () => {
    expect(resolveImagesBindingName(undefined)).toBe('IMAGES');
    expect(resolveImagesBindingName(undefined, 'PHOTOS')).toBe('PHOTOS');
    expect(resolveImagesBindingName({ binding: 'MEDIA' }, 'PHOTOS')).toBe('MEDIA');
  });

  it("does not override a user's root images binding", () => {
    expect(shouldBindImages(true, undefined, undefined)).toBe(true);
    expect(shouldBindImages(true, { binding: 'MEDIA' }, undefined)).toBe(false);
    expect(shouldBindImages(false, undefined, undefined)).toBe(false);
    expect(shouldBindImages(undefined, undefined, undefined)).toBe(false);
  });
});

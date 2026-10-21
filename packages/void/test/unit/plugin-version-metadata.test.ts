import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createWorkerFetch } from '../../src/runtime/routing-worker.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../../src/shared/env.ts';
import {
  CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  DEFAULT_VERSION_METADATA_BINDING,
} from '../../src/shared/version-metadata.ts';

type Config = { config: (resolved: Record<string, unknown>) => Record<string, unknown> };
vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));
vi.mock('../../src/cli/auth.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => null,
}));

const roots: Array<string> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function generate(resolved: Record<string, unknown>, command: 'build' | 'serve' = 'build') {
  const root = mkdtempSync(join(tmpdir(), 'void-version-binding-'));
  roots.push(root);
  mkdirSync(join(root, 'routes'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-09-11' } }),
  );
  writeFileSync(join(root, 'routes/index.ts'), 'export const GET = () => ({ ok: true });');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { voidPlugin } = await import('../../src/index.ts');
  const plugins = voidPlugin();
  const hook = plugins.find((plugin) => plugin.name === 'void:env')?.config;
  const configure = typeof hook === 'function' ? hook : hook?.handler;
  if (!configure) {
    throw new Error('Void environment hook missing');
  }
  (configure as (config: UserConfig, environment: ConfigEnv) => void)(
    {},
    { command, mode: command === 'build' ? 'production' : 'development' },
  );
  const cloudflare = plugins.find((plugin) => plugin.name === 'mock:cloudflare');
  if (!cloudflare) {
    throw new Error('Cloudflare configuration callback missing');
  }
  const patch = (cloudflare.api as { pluginConfig: Config }).pluginConfig.config(resolved);
  const routingHook = plugins.find((plugin) => plugin.name === 'void:routing')?.buildStart;
  const buildStart = typeof routingHook === 'function' ? routingHook : routingHook?.handler;
  if (!buildStart) {
    throw new Error('Void routing hook missing');
  }
  await (buildStart as () => Promise<void>)();
  return { patch, entry: readFileSync(join(root, '.void/entry.ts'), 'utf8') };
}

async function readiness(entry: string, env: Record<string, unknown>): Promise<Response> {
  const source = entry.match(/const __voidFetch = (__createWorkerFetch\([\s\S]*?\n {2}\}\));/)?.[1];
  expect(source).toBeDefined();
  const fetch = new Function(
    '__createWorkerFetch',
    'app',
    'serveWithAssets',
    '__withRawEnv',
    'withRuntimeEnv',
    '__filterInternalBindings',
    '__voidHandleInternalRoute',
    '__voidCollectPrerenderPaths',
    `return (${source});`,
  )(
    createWorkerFetch,
    { fetch: () => new Response('application') },
    (_request: Request, _env: object, response: Response) => response,
    (_env: object, callback: () => Promise<Response>) => callback(),
    (_env: object, callback: () => Promise<Response>) => callback(),
    (bindings: object) => bindings,
    async () => null,
    async () => [],
  ) as ReturnType<typeof createWorkerFetch>;
  return fetch(
    new Request('https://app.test/__void/ready', {
      headers: { 'Cloudflare-Workers-Version-Overrides': 'app="requested-candidate"' },
    }),
    env,
    { waitUntil() {}, passThroughOnException() {}, props: {} },
  );
}

describe('native metadata configuration and generated runtime', () => {
  it('adds Free-compatible self-metadata and threads its name to readiness without paid bindings', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    const providerFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected provider probe'));
    const { patch, entry } = await generate({});
    expect(patch.version_metadata).toEqual({ binding: DEFAULT_VERSION_METADATA_BINDING });
    expect(entry).toContain(`versionMetadataBinding: "${DEFAULT_VERSION_METADATA_BINDING}"`);
    const response = await readiness(entry, {
      [DEFAULT_VERSION_METADATA_BINDING]: {
        id: 'actual-served-version',
        tag: 'private-tag',
        timestamp: 'private-time',
      },
    });
    expect(await response.json()).toEqual({ ready: true, versionId: 'actual-served-version' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(patch.containers).toBeUndefined();
    expect(patch.ai).toBeUndefined();
    expect(patch.hyperdrive).toBeUndefined();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('preserves an authored name in the binding and generated handler', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    const resolved = { version_metadata: { binding: 'AUTHORED_VERSION' } };
    const { patch, entry } = await generate(resolved);
    expect(patch.version_metadata).toBeUndefined();
    expect(resolved.version_metadata).toEqual({ binding: 'AUTHORED_VERSION' });
    expect(entry).toContain('versionMetadataBinding: "AUTHORED_VERSION"');
    const response = await readiness(entry, {
      AUTHORED_VERSION: { id: 'authored-served-version' },
      [DEFAULT_VERSION_METADATA_BINDING]: { id: 'wrong-default-version' },
    });
    expect(await response.json()).toEqual({ ready: true, versionId: 'authored-served-version' });
    expect(await (await readiness(entry, {})).json()).toEqual({ ready: true });
  });

  it('leaves handoff bindings and its legacy runtime unchanged when no metadata exists', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    vi.stubEnv(CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV, '1');
    const { patch, entry } = await generate({});
    expect(patch.version_metadata).toBeUndefined();
    expect(entry).not.toContain('versionMetadataBinding:');
  });

  it.each(['build', 'serve'] as const)(
    'does not inject metadata into a %s outside native deployment',
    async (command) => {
      vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '');
      const { patch, entry } = await generate({}, command);
      expect(patch.version_metadata).toBeUndefined();
      expect(entry).not.toContain('versionMetadataBinding:');
    },
  );

  it('fails before upload when an application variable occupies the internal name', async () => {
    vi.stubEnv(CLOUDFLARE_DEPLOY_BUILD_ENV, '1');
    await expect(
      generate({ vars: { [DEFAULT_VERSION_METADATA_BINDING]: 'application-value' } }),
    ).rejects.toThrow('conflicts with');
  });
});

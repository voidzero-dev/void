import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, UserConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type MockCloudflareConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

vi.mock('@cloudflare/vite-plugin', () => import('../helpers/cloudflare-vite-plugin.ts'));

// Binding inference must not consult a developer's system keychain.
vi.mock('../../src/cli/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/auth.ts')>()),
  getToken: () => null,
}));

const roots: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(ext: string): string {
  const root = mkdtempSync(join(tmpdir(), 'void-route-binding-env-'));
  roots.push(root);
  mkdirSync(join(root, 'routes', 'api'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  writeFileSync(
    join(root, 'routes', 'api', `debug.dev.${ext}`),
    `import { db } from 'void/db';
import { kv } from 'void/kv';
import { storage } from 'void/storage';
import { ai } from 'void/ai';
export const GET = () => ({ db, kv, storage, ai });`,
  );
  return root;
}

async function generatedBindings(
  root: string,
  environment: ConfigEnv,
): Promise<Record<string, unknown>> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { voidPlugin } = await import('../../src/index.ts');
  const plugins = voidPlugin();
  const envPlugin = plugins.find((plugin) => plugin.name === 'void:env');
  const envHook = envPlugin?.config;
  const configure = (typeof envHook === 'function' ? envHook : envHook?.handler) as
    | ((config: UserConfig, environment: ConfigEnv) => void)
    | undefined;
  if (!configure) {
    throw new Error('Expected Void environment plugin.');
  }
  configure({}, environment);
  const cloudflarePlugin = plugins.find((plugin) => plugin.name === 'mock:cloudflare');
  if (!cloudflarePlugin) {
    throw new Error('Expected mocked Cloudflare plugin.');
  }
  return (cloudflarePlugin.api as { pluginConfig: MockCloudflareConfig }).pluginConfig.config({});
}

describe('environment-specific route binding inference', () => {
  it.each(['tsx', 'jsx'])(
    'emits JSX WebSocket bindings only in the selected environment for .ws.%s',
    async (ext) => {
      const root = createProject(ext);
      rmSync(join(root, 'routes', 'api', `debug.dev.${ext}`));
      writeFileSync(
        join(root, 'routes', 'api', `debug.dev.ws.${ext}`),
        `import { kv } from 'void/kv';
import { defineWebSocket } from 'void/ws';
export default defineWebSocket({ onMessage() { return <p>{kv.get('debug')}</p>; } });`,
      );

      const production = await generatedBindings(root, { command: 'build', mode: 'production' });
      expect(production.kv_namespaces).toBeUndefined();
      expect(production.durable_objects).toBeUndefined();

      const development = await generatedBindings(root, { command: 'serve', mode: 'development' });
      expect(development.kv_namespaces).toBeDefined();
      expect(development.durable_objects).toEqual({
        bindings: [{ name: 'ApiDebugWs', class_name: 'ApiDebugWs' }],
      });
    },
  );

  it.each(['ts', 'tsx', 'jsx'])(
    'does not emit production bindings for a dev .%s route',
    async (ext) => {
      const root = createProject(ext);
      const config = await generatedBindings(root, { command: 'build', mode: 'production' });

      expect(config.d1_databases).toBeUndefined();
      expect(config.kv_namespaces).toBeUndefined();
      expect(config.r2_buckets).toBeUndefined();
      expect(config.ai).toBeUndefined();
    },
  );

  it.each(['ts', 'tsx', 'jsx'])(
    'keeps the same bindings when serving the dev .%s route',
    async (ext) => {
      const root = createProject(ext);
      const config = await generatedBindings(root, { command: 'serve', mode: 'development' });

      expect(config.d1_databases).toBeDefined();
      expect(config.kv_namespaces).toBeDefined();
      expect(config.r2_buckets).toBeDefined();
    },
  );

  it.each(['ts', 'tsx', 'jsx'])(
    'does not emit container or live bindings from a dev .%s route',
    async (ext) => {
      const root = createProject(ext);
      writeFileSync(
        join(root, 'routes', 'api', `debug.dev.${ext}`),
        "import { getSandbox } from 'void/sandbox'; import { defineLiveStream } from 'void/live'; export const GET = () => ({ getSandbox, defineLiveStream });",
      );

      const config = await generatedBindings(root, { command: 'build', mode: 'production' });
      expect(config.containers).toBeUndefined();
      expect(config.durable_objects).toBeUndefined();
    },
  );
});

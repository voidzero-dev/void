import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));

const roots: Array<string> = [];

function project(framework = false): string {
  const root = mkdtempSync(join(tmpdir(), 'void-pg-bindings-'));
  roots.push(root);
  writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      devDependencies: framework ? { '@sveltejs/kit': '2.70.3' } : {},
    }),
  );
  const route = framework ? 'src/routes/+page.server.ts' : 'routes/api/users.ts';
  mkdirSync(join(root, framework ? 'src/routes' : 'routes/api'), { recursive: true });
  writeFileSync(join(root, route), "import { db } from 'void/db'; export const GET = () => db;");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('PostgreSQL binding generation', () => {
  it('does not emit a D1 placeholder for a Void app using void/db', async () => {
    const root = project();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    const cloudflarePlugin = voidPlugin().find((plugin) => plugin.name === 'mock:cloudflare');
    if (!cloudflarePlugin) {
      throw new Error('Expected Cloudflare plugin.');
    }
    const config = (cloudflarePlugin.api as { pluginConfig: MockCloudflarePluginConfig })
      .pluginConfig.config;

    const patch = config({});
    expect(patch.d1_databases).toBeUndefined();
  });

  it('does not write a D1 placeholder into a SvelteKit project using void/db', async () => {
    const root = project(true);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    const syncPlugin = voidPlugin().find((plugin) => plugin.name === 'void:wrangler-sync');
    const hook = syncPlugin?.configResolved;
    const handler = typeof hook === 'function' ? hook : hook?.handler;
    if (!handler) {
      throw new Error('Expected Wrangler sync plugin.');
    }
    handler.call({} as never, { command: 'serve' } as ResolvedConfig);

    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.d1_databases).toBeUndefined();
  });
});

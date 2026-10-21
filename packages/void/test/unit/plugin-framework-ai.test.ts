import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// Framework adapters own the Cloudflare runtime, so these hooks never call the real plugin.
vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));

const roots: Array<string> = [];

function project(
  platform: 'cloudflare' | 'void',
  options?: { aiName?: string; explicitAi?: boolean },
) {
  const root = mkdtempSync(join(tmpdir(), 'void-framework-ai-'));
  roots.push(root);
  mkdirSync(join(root, 'src/routes'), { recursive: true });
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: { '@sveltejs/kit': '2.0.0' },
    }),
  );
  writeFileSync(join(root, '.void/project.json'), JSON.stringify({ platform }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify(options?.aiName ? { inference: { bindings: { ai: options.aiName } } } : {}),
  );
  writeFileSync(
    join(root, 'src/routes/+page.server.ts'),
    "import { ai } from 'void/ai'; export const load = async () => ai.run('@cf/meta/llama', {});",
  );
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'framework-ai',
      ...(options?.explicitAi ? { ai: { binding: 'EXPLICIT_AI', staging: true } } : {}),
    }),
  );
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runFrameworkSync(root: string): Promise<Record<string, unknown>> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { voidPlugin } = await import('../../src/index.ts');
  const sync = voidPlugin().find((plugin) => plugin.name === 'void:wrangler-sync');
  const configHook = sync?.config;
  const configHandler = typeof configHook === 'function' ? configHook : configHook?.handler;
  if (!configHandler) {
    throw new Error('Expected early framework Wrangler sync hook');
  }
  configHandler.call({} as never, {} as never, { command: 'serve' } as never);
  const hook = sync?.configResolved;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) {
    throw new Error('Expected framework Wrangler sync hook');
  }
  handler.call({} as never, { command: 'serve' } as ResolvedConfig);
  return JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
}

async function runFrameworkCompat(root: string, command: 'serve' | 'build'): Promise<void> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const { voidPlugin } = await import('../../src/index.ts');
  const compat = voidPlugin().find((plugin) => plugin.name === 'void:wrangler-compat');
  const hook = compat?.config;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) {
    throw new Error('Expected framework Wrangler compatibility hook');
  }
  handler.call({} as never, {} as never, { command } as never);
}

describe('framework Workers AI bindings', () => {
  it.each(['serve', 'build'] as const)(
    'uses the Void Cloudflare login before a direct framework %s opens a remote session',
    async (command) => {
      vi.stubEnv('CLOUDFLARE_CF_AUTH', undefined);
      vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', 'false');
      await runFrameworkCompat(project('cloudflare'), command);
      expect(process.env.CLOUDFLARE_CF_AUTH).toBe('true');
      expect(process.env.CLOUDFLARE_AUTH_USE_KEYRING).toBe('true');
    },
  );

  it('leaves Cloudflare login selection alone for managed framework development', async () => {
    vi.stubEnv('CLOUDFLARE_CF_AUTH', undefined);
    vi.stubEnv('CLOUDFLARE_AUTH_USE_KEYRING', 'false');
    await runFrameworkCompat(project('void'), 'serve');
    expect(process.env.CLOUDFLARE_CF_AUTH).toBeUndefined();
    expect(process.env.CLOUDFLARE_AUTH_USE_KEYRING).toBe('false');
  });

  it('adds remote AI for a directly connected SvelteKit project', async () => {
    const config = await runFrameworkSync(project('cloudflare'));
    expect(config.ai).toEqual({ binding: 'AI', remote: true });
  });

  it('preserves a user AI binding while making it remote in direct development', async () => {
    const config = await runFrameworkSync(project('cloudflare', { explicitAi: true }));
    expect(config.ai).toEqual({ binding: 'EXPLICIT_AI', staging: true, remote: true });
    expect(config.vars).toMatchObject({ __VOID_AI_BINDING: 'EXPLICIT_AI' });
  });

  it('routes a configured custom AI binding through the runtime helper', async () => {
    const config = await runFrameworkSync(project('cloudflare', { aiName: 'MY_AI' }));
    expect(config.ai).toEqual({ binding: 'MY_AI', remote: true });
    expect(config.vars).toMatchObject({ __VOID_AI_BINDING: 'MY_AI' });
  });

  it('does not add paid AI bindings for managed framework development', async () => {
    const config = await runFrameworkSync(project('void'));
    expect(config.ai).toBeUndefined();
  });

  it('does not add an AI binding when a direct framework app does not use AI', async () => {
    const root = project('cloudflare');
    writeFileSync(
      join(root, 'src/routes/+page.server.ts'),
      'export const load = () => ({ ok: true });',
    );
    const config = await runFrameworkSync(root);
    expect(config.ai).toBeUndefined();
  });
});

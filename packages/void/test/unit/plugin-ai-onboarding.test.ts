import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigEnv, PluginOption, UserConfig, ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const runAiSetupPrompt = vi.hoisted(() => vi.fn());

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));
vi.mock('../../src/plugin-ai-setup.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/plugin-ai-setup.ts')>()),
  // Signed in to Void, with no project linked.
  readVoidDevCredentials: () => ({
    status: 'no-project',
    apiUrl: 'https://void.example',
    token: 'token',
  }),
  runAiSetupPrompt,
}));

const roots: Array<string> = [];
const isTTY = process.stdin.isTTY;

afterEach(() => {
  process.stdin.isTTY = isTTY;
  runAiSetupPrompt.mockClear();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Starts `void:env` for an app that uses `void/ai`, in a server with the given plugins. */
async function startAiApp(plugins: Array<PluginOption>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'void-ai-onboarding-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  writeFileSync(
    join(root, 'routes/api/chat.ts'),
    "import { ai } from 'void/ai';\n\nexport const POST = () => ai;\n",
  );
  vi.spyOn(process, 'cwd').mockReturnValue(root);

  const { voidPlugin } = await import('../../src/index.ts');
  const envPlugin = voidPlugin().find((plugin) => plugin.name === 'void:env');
  const config = getHookHandler(envPlugin?.config) as (config: UserConfig, env: ConfigEnv) => void;
  config({}, { command: 'serve', mode: 'development' });
  const configureServer = getHookHandler(envPlugin?.configureServer) as (
    server: ViteDevServer,
  ) => void;
  // Without an HTTP server, the setup starts right away.
  configureServer({ config: { plugins }, httpServer: null } as unknown as ViteDevServer);
}

describe('AI project setup in development', () => {
  it('asks which project to link when the dev server starts in a terminal', async () => {
    process.stdin.isTTY = true;
    await startAiApp([]);

    expect(runAiSetupPrompt).toHaveBeenCalledOnce();
  });

  it("prints how to link one instead in Vitest's server", async () => {
    process.stdin.isTTY = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Vitest adds plugins of its own to the server that runs the tests.
    await startAiApp([{ name: 'vitest:config' }]);

    expect(runAiSetupPrompt).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('AI requires a linked project.');
  });
});

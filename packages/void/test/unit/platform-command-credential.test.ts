import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { runPlatformWranglerForConditionalCreate } from '../../src/cli/platform-installer-process.ts';
import { createDefaultRunWrangler, provisionEnv } from '../../src/cli/provision.ts';

const state = vi.hoisted(() => ({ launcher: [] as Array<string> }));
vi.mock('../../src/cli/preset.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/preset.ts')>()),
  resolveCloudflareOperationArgv: () => state.launcher,
}));

afterEach(() => vi.unstubAllEnvs());

it.each(['linux', 'win32'] as const)(
  'pins an explicit token and removes conflicting credentials on %s',
  (platform) => {
    for (const key of [
      'CLOUDFLARE_API_TOKEN',
      'CF_API_TOKEN',
      'CLOUDFLARE_API_KEY',
      'CF_API_KEY',
      'CLOUDFLARE_EMAIL',
      'CF_EMAIL',
    ]) {
      vi.stubEnv(key, 'ambient');
      if (platform === 'win32') {
        vi.stubEnv(key.toLowerCase(), 'ambient');
      }
    }
    const env = provisionEnv({ accountId: 'account', apiToken: 'selected-manager', platform });
    expect(env.CLOUDFLARE_API_TOKEN).toBe('selected-manager');
    for (const key of [
      'CF_API_TOKEN',
      'CLOUDFLARE_API_KEY',
      'CF_API_KEY',
      'CLOUDFLARE_EMAIL',
      'CF_EMAIL',
    ]) {
      expect(env[key]).toBeUndefined();
    }
    if (platform === 'win32') {
      expect(env.cloudflare_api_token).toBeUndefined();
    }
    expect(process.env.CLOUDFLARE_API_TOKEN).toBe('ambient');
  },
);

it('passes the selected token to the real subprocess without putting it in argv or output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-credential-'));
  try {
    const launcher = join(directory, 'inspect.mjs');
    writeFileSync(
      launcher,
      `
const matches = process.env.CLOUDFLARE_API_TOKEN === 'selected-manager';
const isolated = !process.env.CF_API_TOKEN && !process.env.CLOUDFLARE_API_KEY;
const argvSafe = !process.argv.some(arg => arg.includes('selected-manager'));
process.stdout.write(JSON.stringify({operationResult: 1, data: {matches, isolated, argvSafe}}));
`,
    );
    vi.stubEnv('CF_API_TOKEN', 'ambient');
    vi.stubEnv('CLOUDFLARE_API_KEY', 'ambient-key');
    const run = createDefaultRunWrangler(directory, { launcher: [process.execPath, launcher] });
    const result = await run(
      { type: 'r2.bucket.info', name: 'assets' },
      { accountId: 'account', apiToken: 'selected-manager' },
    );
    expect(result.status).toBe(0);
    expect(result.data).toEqual({ matches: true, isolated: true, argvSafe: true });
    expect(JSON.stringify(result)).not.toContain('selected-manager');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps the operator credential through the guarded new-Worker create proxy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-create-credential-'));
  const received: Array<{ authorization: string | undefined; path: string | undefined }> = [];
  const server = createServer((request, response) => {
    received.push({ authorization: request.headers.authorization, path: request.url });
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ success: true, result: {} }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const launcher = join(directory, 'create.mjs');
    writeFileSync(
      launcher,
      `
const response = await fetch(process.env.CLOUDFLARE_API_BASE_URL + '/accounts/account/workers/scripts/worker', {
  method: 'PUT', headers: {Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN}, body: 'worker'
});
process.stdout.write(JSON.stringify({operationResult: 1, data: {ok: response.ok}}));
`,
    );
    state.launcher = [process.execPath, launcher];
    const result = await runPlatformWranglerForConditionalCreate(
      { type: 'worker.deploy', configPath: join(directory, 'wrangler.json') },
      'account',
      directory,
      true,
      'worker',
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
      'selected-manager',
    );
    expect(result.status).toBe(0);
    expect(result.data).toEqual({ ok: true });
    expect(received).toEqual([
      {
        authorization: 'Bearer selected-manager',
        path: '/client/v4/accounts/account/workers/scripts/worker',
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

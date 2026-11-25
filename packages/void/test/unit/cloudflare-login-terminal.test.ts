import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
  runCloudflareAuthCommand,
} from '../../src/cli/cloudflare-auth.ts';
import { createDeployWranglerRunner } from '../../src/cli/deploy.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock('../../src/cli/preset.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/preset.ts')>()),
  resolveCloudflareOperationArgv: () => [process.execPath, 'bundled-cli.js'],
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('cf browser login', () => {
  it.each([
    ['Cloudflare commands', () => createBundledCloudflareAuthRunner(process.cwd())],
    [
      'deploy',
      () => {
        const run = createDeployWranglerRunner(
          process.cwd(),
          'account-id',
          'https://api.cloudflare.com/client/v4',
        );
        return (operation: CloudflareOperation, capture: boolean) => run(operation, { capture });
      },
    ],
  ] as const)('%s shows the live login prompt', async (_, create) => {
    vi.spyOn(log, 'info').mockImplementation(() => {});
    let reads = 0;
    vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
      const action = JSON.parse(args![1]).type;
      if (action === 'auth.login') {
        expect(
          options?.stdio === 'inherit' ||
            (Array.isArray(options?.stdio) && options.stdio.every((value) => value === 'inherit')),
        ).toBe(true);
      } else {
        expect(options?.stdio).toContain('pipe');
      }
      const authenticated = action === 'auth.whoami' && ++reads === 2;
      return {
        status: action === 'auth.login' || authenticated ? 0 : 1,
        stdout: authenticated
          ? JSON.stringify({
              operationResult: 1,
              data: { loggedIn: true, accounts: [{ id: 'account-id' }] },
            })
          : '',
        stderr: '',
        signal: null,
        pid: 1,
        output: [],
      };
    });
    await expect(
      ensureCloudflareAuthentication({ runWrangler: create(), interactive: true }),
    ).resolves.toMatchObject({
      accounts: [{ id: 'account-id' }],
    });
    expect(vi.mocked(spawnSync).mock.calls.map((call): unknown => JSON.parse(call[1]![1]))).toEqual(
      [{ type: 'auth.whoami' }, { type: 'auth.login' }, { type: 'auth.whoami' }],
    );
  });

  it('captures and decodes logout even when the caller requests human output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        operationResult: 1,
        data: { removed: true },
        output: 'Session removed.\n',
      }),
      stderr: 'Provider note.\n',
      signal: null,
      pid: 1,
      output: [],
    });
    const result = await createBundledCloudflareAuthRunner(process.cwd())(
      { type: 'auth.logout' },
      false,
    );
    expect(result).toMatchObject({ status: 0, data: { removed: true } });
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(stdout).toHaveBeenCalledWith('Session removed.\n');
    expect(stderr).toHaveBeenCalledWith('Provider note.\n');
  });

  it('runs asynchronous login with inherited terminal and supports cancellation', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const controller = new AbortController();
    const result = runCloudflareAuthCommand(
      process.cwd(),
      { type: 'auth.login' },
      controller.signal,
    );
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['bundled-cli.js', JSON.stringify({ type: 'auth.login' })],
      expect.objectContaining({
        stdio: 'inherit',
        signal: controller.signal,
      }),
    );
    child.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('reports an asynchronous login spawn failure', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const result = runCloudflareAuthCommand(process.cwd(), { type: 'auth.login' });
    child.emit('error', new Error('spawn failed'));
    child.emit('close', 0, null);
    await expect(result).resolves.toMatchObject({ status: null, error: 'spawn failed' });
  });
});

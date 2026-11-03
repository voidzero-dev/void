import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancel, confirm, CANCEL_SYMBOL, password } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { number, string } from '../../src/runtime/env-helpers.ts';
import { defineEnv } from '../../src/runtime/env-public.ts';

const cloudflare = vi.hoisted(() => ({
  put: vi.fn(),
  sync: vi.fn(),
  resolve: vi.fn(() => ({ workerName: 'app' })),
}));

vi.mock('../../src/cli/cloudflare-operations.ts', () => ({
  deleteCloudflareSecret: vi.fn(),
  listCloudflareSecrets: vi.fn(),
  putCloudflareSecret: cloudflare.put,
  resolveCloudflareOperationContext: cloudflare.resolve,
  syncCloudflareSecrets: cloudflare.sync,
}));

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return {
    ...original,
    confirm: vi.fn(),
    cancel: vi.fn(),
    password: vi.fn(),
  };
});

import { runSecretCommand } from '../../src/cli/secret.ts';

const roots: Array<string> = [];
const terminalStreams = [process.stdin, process.stdout];
const ttyDescriptors = terminalStreams.map((stream) =>
  Object.getOwnPropertyDescriptor(stream, 'isTTY'),
);

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-secret-validation-'));
  roots.push(root);
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(join(root, '.void/project.json'), '{"platform":"cloudflare"}\n');
  writeFileSync(join(root, 'env.ts'), 'export {};\n');
  return root;
}

beforeEach(() => {
  vi.stubEnv('CI', '');
  for (const stream of terminalStreams) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, get: () => true });
  }
  defineEnv({});
  cloudflare.put.mockReset();
  cloudflare.sync.mockReset();
  cloudflare.resolve.mockClear();
  vi.mocked(confirm).mockReset();
  vi.mocked(cancel).mockReset();
  vi.mocked(password).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [index, stream] of terminalStreams.entries()) {
    const descriptor = ttyDescriptors[index];
    if (descriptor) {
      Object.defineProperty(stream, 'isTTY', descriptor);
    } else {
      Reflect.deleteProperty(stream, 'isTTY');
    }
  }
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('direct Cloudflare secret validation', () => {
  it.each([
    ['an undeclared name', 'OTHER', 'value', 'OTHER is not declared in env.ts'],
    [
      'a client-exposed name',
      'VITE_API_URL',
      'https://example.com',
      'VITE_API_URL is client-exposed',
    ],
  ])('rejects %s before invoking Wrangler', async (_label, name, value, message) => {
    const root = project();
    defineEnv({ API_TOKEN: string(), VITE_API_URL: string() });

    await expect(runSecretCommand(root, { action: 'put', name, value })).rejects.toThrow(message);
    expect(cloudflare.put).not.toHaveBeenCalled();
    expect(cloudflare.sync).not.toHaveBeenCalled();
  });

  it('rejects invalid bulk values before invoking Wrangler', async () => {
    const root = project();
    const dotenv = join(root, 'production.env');
    writeFileSync(dotenv, 'PORT=not-a-number\n');
    defineEnv({ PORT: number() });

    await expect(runSecretCommand(root, { action: 'sync', file: dotenv })).rejects.toThrow(
      'PORT failed env.ts validation',
    );
    expect(cloudflare.put).not.toHaveBeenCalled();
    expect(cloudflare.sync).not.toHaveBeenCalled();
  });

  it('uploads a declared server value after it passes validation', async () => {
    const root = project();
    defineEnv({ API_TOKEN: string() });

    await runSecretCommand(root, { action: 'put', name: 'API_TOKEN', value: 'secret' });

    expect(cloudflare.put).toHaveBeenCalledWith({ workerName: 'app' }, 'API_TOKEN', 'secret');
  });

  it.each([
    ['declined', false],
    ['cancelled', CANCEL_SYMBOL],
  ])('exits non-zero when sync confirmation is %s', async (_label, answer) => {
    const root = project();
    const dotenv = join(root, 'production.env');
    writeFileSync(dotenv, 'API_TOKEN=secret\n');
    defineEnv({ API_TOKEN: string() });
    vi.mocked(confirm).mockResolvedValueOnce(answer as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);

    await expect(runSecretCommand(root, { action: 'sync', file: dotenv })).rejects.toThrow(
      'process.exit:1',
    );
    expect(cancel).toHaveBeenCalledWith('Secret sync cancelled.');
    expect(cloudflare.sync).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it.each(['stdin', 'stdout', 'CI'] as const)(
    'requires --yes when %s is non-interactive',
    async (stream) => {
      if (stream === 'CI') {
        vi.stubEnv('CI', 'true');
      } else {
        vi.spyOn(process[stream], 'isTTY', 'get').mockReturnValue(false);
      }
      const root = project();
      const dotenv = join(root, 'production.env');
      writeFileSync(dotenv, 'API_TOKEN=secret\n');
      defineEnv({ API_TOKEN: string() });

      await expect(runSecretCommand(root, { action: 'sync', file: dotenv })).rejects.toThrow(
        'Pass --yes',
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(cloudflare.sync).not.toHaveBeenCalled();
    },
  );

  it('syncs without confirmation in CI with closed stdin when --yes is set', async () => {
    vi.stubEnv('CI', 'true');
    for (const stream of terminalStreams) {
      vi.spyOn(stream, 'isTTY', 'get').mockReturnValue(false);
    }
    const root = project();
    const dotenv = join(root, 'production.env');
    writeFileSync(dotenv, 'API_TOKEN=secret\n');
    defineEnv({ API_TOKEN: string() });

    await runSecretCommand(root, { action: 'sync', file: dotenv, yes: true });

    expect(confirm).not.toHaveBeenCalled();
    expect(cloudflare.sync).toHaveBeenCalledOnce();
  });

  it('exits non-zero when the put password prompt is cancelled', async () => {
    const root = project();
    defineEnv({ API_TOKEN: string() });
    vi.mocked(password).mockResolvedValueOnce(CANCEL_SYMBOL as never);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);

    try {
      await expect(runSecretCommand(root, { action: 'put', name: 'API_TOKEN' })).rejects.toThrow(
        'process.exit:1',
      );
    } finally {
      exit.mockRestore();
      if (tty) {
        Object.defineProperty(process.stdin, 'isTTY', tty);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
    }
    expect(cancel).toHaveBeenCalledWith('Secret command cancelled.');
    expect(cloudflare.put).not.toHaveBeenCalled();
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { string } from '../../src/runtime/env/helpers.ts';
import { defineEnv } from '../../src/runtime/env/public.ts';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn((): string | null => 'void-token'),
  listHostedSecrets: vi.fn(async () => [{ name: 'API_TOKEN' }]),
  listCloudflareSecrets: vi.fn(async () => ['API_TOKEN']),
  resolveCloudflareContext: vi.fn(() => ({ workerName: 'app' })),
  platformClient: vi.fn(),
}));

vi.mock('../../src/cli/auth.ts', () => ({ getToken: mocks.getToken }));
vi.mock('../../src/cli/client.ts', () => ({
  PlatformClient: class {
    constructor(...args: Array<unknown>) {
      mocks.platformClient(...args);
    }

    listSecrets = mocks.listHostedSecrets;
  },
}));
vi.mock('../../src/cli/cloudflare-operations.ts', () => ({
  listCloudflareSecrets: mocks.listCloudflareSecrets,
  resolveCloudflareOperationContext: mocks.resolveCloudflareContext,
}));

import { runEnvCommand } from '../../src/cli/env.ts';

const roots: Array<string> = [];

function project(platform: 'cloudflare' | 'void' | 'none'): string {
  const root = mkdtempSync(join(tmpdir(), 'void-env-target-'));
  roots.push(root);
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileSync(
    join(root, '.void/project.json'),
    JSON.stringify({ platform, projectId: 'project-1', slug: 'app' }),
  );
  writeFileSync(join(root, 'env.ts'), 'export {};\n');
  return root;
}

beforeEach(() => {
  defineEnv({ API_TOKEN: string() });
  vi.clearAllMocks();
  mocks.getToken.mockReturnValue('void-token');
  mocks.listHostedSecrets.mockResolvedValue([{ name: 'API_TOKEN' }]);
  mocks.listCloudflareSecrets.mockResolvedValue(['API_TOKEN']);
});

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('env check --remote target dispatch', () => {
  it('lists direct Cloudflare secrets without hosted authentication', async () => {
    const root = project('cloudflare');

    await runEnvCommand(root, { subcommand: 'check', useRemoteSecrets: true });

    expect(mocks.resolveCloudflareContext).toHaveBeenCalledWith(root);
    expect(mocks.listCloudflareSecrets).toHaveBeenCalledWith({ workerName: 'app' });
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.platformClient).not.toHaveBeenCalled();
    expect(mocks.listHostedSecrets).not.toHaveBeenCalled();
  });

  it('retains hosted Void secret lookup for Void projects', async () => {
    const root = project('void');

    await runEnvCommand(root, { subcommand: 'check', useRemoteSecrets: true });

    expect(mocks.getToken).toHaveBeenCalledWith(root);
    expect(mocks.platformClient).toHaveBeenCalledWith('void-token', { root });
    expect(mocks.listHostedSecrets).toHaveBeenCalledWith('project-1');
    expect(mocks.listCloudflareSecrets).not.toHaveBeenCalled();
  });

  it('rejects remote checks when deployment is disabled', async () => {
    const root = project('none');

    await expect(
      runEnvCommand(root, { subcommand: 'check', useRemoteSecrets: true }),
    ).rejects.toThrow('Deployment is disabled');
    expect(mocks.listCloudflareSecrets).not.toHaveBeenCalled();
    expect(mocks.listHostedSecrets).not.toHaveBeenCalled();
  });
});

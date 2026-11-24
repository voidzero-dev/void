import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { runProjectTokenCommand } from '../../src/cli/project-token.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const roots: Array<string> = [];

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VOID_TOKEN;
  delete process.env.VOID_API_URL;
  delete process.env.VOID_ACCESS_ORIGIN;
  delete process.env.CF_ACCESS_CLIENT_ID;
  delete process.env.CF_ACCESS_CLIENT_SECRET;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function projectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'void-project-token-'));
  roots.push(root);
  process.env.VOID_PLATFORM_REGISTRY_DIR = join(root, 'registry');
  savePlatformConnection({
    accountId: null,
    apiUrl: 'https://api.example.test',
    applicationDomain: 'apps.example.test',
    displayName: 'Test platform',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.example.test',
  });
  mkdirSync(join(root, '.void'));
  writeFileSync(
    join(root, '.void/project.json'),
    JSON.stringify({
      platform: 'void',
      platformUrl: 'https://api.example.test',
      projectId: 'project-1',
      slug: 'app',
    }),
  );
  return root;
}

describe('project token command', () => {
  it('creates a project credential with human auth and origin-scoped Access proof', async () => {
    const root = projectRoot();
    process.env.VOID_TOKEN = 'human-token';
    process.env.VOID_API_URL = 'https://api.example.test';
    process.env.VOID_ACCESS_ORIGIN = 'https://api.example.test';
    process.env.CF_ACCESS_CLIENT_ID = 'access-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'access-secret';
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        {
          id: 'credential-1',
          name: 'ci',
          createdAt: '2026-09-18T00:00:00.000Z',
          expiresAt: '2026-10-18T00:00:00.000Z',
          revokedAt: null,
          token: 'deploy-token',
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', withPlatformDiscovery(request));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runProjectTokenCommand(root, {
      subcommand: 'token',
      action: 'create',
      credentialId: '',
      projectSlug: '',
      name: 'ci',
      expiresInDays: 30,
      json: true,
    });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://api.example.test/projects/project-1/tokens');
    expect(init).toBeDefined();
    expect(init!).toMatchObject({ method: 'POST', redirect: 'manual' });
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer human-token');
    expect(headers['CF-Access-Client-Id']).toBe('access-id');
    expect(headers['CF-Access-Client-Secret']).toBe('access-secret');
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        id: 'credential-1',
        name: 'ci',
        createdAt: '2026-09-18T00:00:00.000Z',
        expiresAt: '2026-10-18T00:00:00.000Z',
        revokedAt: null,
        token: 'deploy-token',
        apiUrl: 'https://api.example.test',
      }),
    );
  });
});

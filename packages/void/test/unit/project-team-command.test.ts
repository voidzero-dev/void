import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import {
  platformCredentialAccount,
  savePlatformConnection,
} from '../../src/cli/platform-registry.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const keyring = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: keyring.read,
  writeKeyringPassword: keyring.write,
  deleteKeyringPassword: keyring.remove,
}));

const roots: Array<string> = [];

function rootWithPlatform(
  platform: 'cloudflare' | 'void',
  metadata: Record<string, unknown> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-team-'));
  roots.push(root);
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, 'registry'));
  connect('https://api.example.test', 'Test platform');
  mkdirSync(join(root, '.void'));
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({
      platform,
      projectId: 'project_1',
      slug: 'my-app',
      platformUrl: 'https://api.example.test',
      ...metadata,
    }),
  );
  return root;
}

function connect(apiUrl: string, displayName: string): void {
  savePlatformConnection({
    accountId: null,
    apiUrl,
    applicationDomain: null,
    displayName,
    installationId: null,
    kind: 'connected',
    proxyUrl: null,
  });
}

beforeEach(() => {
  keyring.read.mockReset().mockReturnValue(null);
  keyring.write.mockReset().mockReturnValue(true);
  keyring.remove.mockReset().mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project team target selection', () => {
  it('fails clearly before contacting a direct Cloudflare target', async () => {
    await expect(
      runProjectCommand(rootWithPlatform('cloudflare'), {
        subcommand: 'team',
        action: 'list',
        projectSlug: '',
      }),
    ).rejects.toThrow(
      'Teams are available only for projects hosted on a Void platform, not direct Cloudflare deployments',
    );
  });

  it('allows account invitation responses from a direct Cloudflare project directory', async () => {
    const root = rootWithPlatform('cloudflare');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/me/project-invitations')
        ? Response.json({ invitations: [] })
        : Response.json({});
    });
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));

    await runProjectCommand(root, { subcommand: 'team', action: 'pending' });
    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'accept',
      invitationId: 'pinv_1',
    });
    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'decline',
      invitationId: 'pinv_1',
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.example.test/me/project-invitations',
      'https://api.example.test/project-invitations/pinv_1/accept',
      'https://api.example.test/project-invitations/pinv_1/decline',
    ]);
  });

  it.each(['cloudflare', 'void'] as const)(
    'uses the active connection for account invitations from a read-only %s project linked elsewhere',
    async (platform) => {
      const platformA = 'https://platform-a.example.test';
      const platformB = 'https://platform-b.example.test';
      const root = rootWithPlatform(platform, { platformUrl: platformA });
      const projectPath = join(root, '.void', 'project.json');
      const originalProject = readFileSync(projectPath, 'utf8');
      connect(platformA, 'Platform A');
      connect(platformB, 'Platform B');
      keyring.read.mockImplementation((service: string, account: string) => {
        if (service !== 'dev.void.cli') {
          return null;
        }
        if (account === platformCredentialAccount(platformA)) {
          return 'platform-a-token';
        }
        return account === platformCredentialAccount(platformB) ? 'platform-b-token' : null;
      });
      const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return url.endsWith('/me/project-invitations')
          ? Response.json({ invitations: [] })
          : Response.json({});
      });
      vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));

      chmodSync(projectPath, 0o444);
      chmodSync(join(root, '.void'), 0o555);
      try {
        await runProjectCommand(root, { subcommand: 'team', action: 'pending' });
        await runProjectCommand(root, {
          subcommand: 'team',
          action: 'accept',
          invitationId: 'pinv_1',
        });
        await runProjectCommand(root, {
          subcommand: 'team',
          action: 'decline',
          invitationId: 'pinv_1',
        });
        expect(readFileSync(projectPath, 'utf8')).toBe(originalProject);
      } finally {
        chmodSync(join(root, '.void'), 0o755);
        chmodSync(projectPath, 0o644);
      }

      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        `${platformB}/me/project-invitations`,
        `${platformB}/project-invitations/pinv_1/accept`,
        `${platformB}/project-invitations/pinv_1/decline`,
      ]);
      for (const [, init] of fetchMock.mock.calls) {
        expect(init).toMatchObject({
          headers: expect.objectContaining({ Authorization: 'Bearer platform-b-token' }),
        });
      }
    },
  );

  it.each(['cloudflare', 'void'] as const)(
    'rejects an unscoped VOID_TOKEN for account invitations from a %s project',
    async (platform) => {
      const platformA = 'https://platform-a.example.test';
      const platformB = 'https://platform-b.example.test';
      const root = rootWithPlatform(platform, { platformUrl: platformA });
      vi.stubEnv('VOID_TOKEN', 'void-cloud-token');
      vi.stubEnv('VOID_API_URL', undefined);
      connect(platformA, 'Platform A');
      connect(platformB, 'Platform B');
      keyring.read.mockImplementation((service: string, account: string) =>
        service === 'dev.void.cli' && account === platformCredentialAccount(platformB)
          ? 'platform-b-token'
          : null,
      );
      const fetchMock = vi.fn(async () => Response.json({ invitations: [] }));
      vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));

      await expect(
        runProjectCommand(root, { subcommand: 'team', action: 'pending' }),
      ).rejects.toThrow('Set VOID_API_URL alongside VOID_TOKEN');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('uses an explicit environment origin and its matching token over saved project and active connections', async () => {
    const root = rootWithPlatform('void', { platformUrl: 'https://platform-a.example.test' });
    connect('https://platform-b.example.test', 'Platform B');
    connect('https://platform-c.example.test', 'Platform C');
    vi.stubEnv('VOID_API_URL', 'https://platform-c.example.test/');
    vi.stubEnv('VOID_TOKEN', 'platform-c-token');
    const fetchMock = vi.fn(async () => Response.json({ invitations: [] }));
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await runProjectCommand(root, { subcommand: 'team', action: 'pending' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform-c.example.test/me/project-invitations',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer platform-c-token' }),
      }),
    );
    expect(output.join('')).toContain('Platform: https://platform-c.example.test');
  });

  it('never falls back to the linked project token when the active platform has no login', async () => {
    const platformA = 'https://platform-a.example.test';
    const platformB = 'https://platform-b.example.test';
    const root = rootWithPlatform('void', { platformUrl: platformA });
    connect(platformA, 'Platform A');
    connect(platformB, 'Platform B');
    keyring.read.mockImplementation((service: string, account: string) =>
      service === 'dev.void.cli' && account === platformCredentialAccount(platformA)
        ? 'platform-a-token'
        : null,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('missing login');
    });

    await expect(
      runProjectCommand(root, { subcommand: 'team', action: 'pending' }),
    ).rejects.toThrow('missing login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the linked Void platform project for member listing', async () => {
    const platformA = 'https://platform-a.example.test';
    const platformB = 'https://platform-b.example.test';
    const root = rootWithPlatform('void', { platformUrl: platformA });
    connect(platformA, 'Platform A');
    connect(platformB, 'Platform B');
    keyring.read.mockImplementation((service: string, account: string) => {
      if (service !== 'dev.void.cli') {
        return null;
      }
      if (account === platformCredentialAccount(platformA)) {
        return 'platform-a-token';
      }
      return account === platformCredentialAccount(platformB) ? 'platform-b-token' : null;
    });
    const fetchMock = vi.fn(async () =>
      Response.json({
        members: [{ user: { id: 'user_1', login: 'alex' }, role: 'owner' }],
      }),
    );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));

    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'list',
      projectSlug: '',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${platformA}/projects/project_1/members`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer platform-a-token' }),
      }),
    );
  });

  it('prints platform warnings before the member list', async () => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    let warnings: Array<string> | undefined = ['stuck \u001b[31mred'];
    vi.stubGlobal(
      'fetch',
      withPlatformDiscovery(
        vi.fn(async () =>
          Response.json({
            members: [{ user: { id: 'user_1', login: 'alex' }, role: 'owner' }],
            ...(warnings ? { warnings } : {}),
          }),
        ),
      ),
    );
    let written = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written += String(chunk);
      return true;
    });
    const warnedAt: Array<number> = [];
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {
      warnedAt.push(written.length);
    });
    const list = () =>
      runProjectCommand(root, { subcommand: 'team', action: 'list', projectSlug: '' });

    await list();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('stuck  [31mred');
    expect(written.indexOf('alex')).toBeGreaterThan(warnedAt[0]);

    warn.mockClear();
    warnings = undefined;
    await list();
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves an explicit project override before acting', async () => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'project_2',
            user_id: 'owner_1',
            slug: 'other-app',
            type: 'worker',
            created_at: '2026-09-17T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          members: [{ user: { id: 'owner_1', login: 'owner' }, role: 'owner' }],
        }),
      );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));

    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'list',
      projectSlug: 'other-app',
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.example.test/projects',
      'https://api.example.test/projects/project_2/members',
    ]);
  });

  it('scrubs control characters from invitation confirmation output', async () => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          invitation: {
            id: 'pinv_1',
            target: { id: 'user_1', login: 'target', email: 'target\u0007@example.com' },
            role: 'reader',
            created_at: '2026-09-22T00:00:00Z',
            expires_at: '2026-09-29T00:00:00Z',
          },
          refreshed: false,
          delivery: { status: 'sent' },
        }),
      ),
    );
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await runProjectCommand(root, {
      subcommand: 'team',
      action: 'invite',
      email: 'target@example.com',
      role: 'reader',
      projectSlug: '',
    });

    expect(output.join('')).not.toContain('\u0007');
    expect(output.join('')).toContain('target @example.com');
  });

  it.each(['failed', 'not_configured', 'rate_limited'])(
    'shows recovery instructions when invitation email is %s',
    async (status) => {
      const root = rootWithPlatform('void');
      vi.stubEnv('VOID_TOKEN', 'test-token');
      vi.stubEnv('VOID_API_URL', 'https://api.example.test');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            invitation: { id: 'pinv_a1b2c3d4e5f6', target_email: 'target@example.com' },
            refreshed: false,
            delivery: { status },
          }),
        ),
      );
      const output: Array<string> = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });

      await runProjectCommand(root, {
        subcommand: 'team',
        action: 'invite',
        email: 'target@example.com',
        role: 'reader',
        projectSlug: '',
      });

      expect(output.join('')).toContain('Invitation saved; email was not sent');
      expect(output.join('')).toContain('Invitation: pinv_a1b2c3d4e5f6');
      expect(output.join('')).toContain("void connect 'https://api.example.test'");
      expect(output.join('')).toContain('void project team pending');
      expect(output.join('')).toContain('void project team accept pinv_a1b2c3d4e5f6');
    },
  );

  it.each([
    {
      error: 'project invitation not found',
      status: 404,
      message: 'Invitation not found on https://api.example.test',
      recovery: 'void connect <url>',
    },
    {
      error: 'forbidden',
      status: 403,
      message: 'Your account cannot respond',
      recovery: 'void account logout',
    },
    {
      error: 'project invitation has expired',
      status: 409,
      message: 'This invitation has expired',
      recovery: 'invite you again',
    },
    {
      error: 'project invitation is no longer pending',
      status: 409,
      message: 'already been answered or revoked',
      recovery: 'check your access',
    },
  ])('explains $error with a recovery action', async ({ error, status, message, recovery }) => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error }, { status })),
    );

    const result = runProjectCommand(root, {
      subcommand: 'team',
      action: 'accept',
      invitationId: 'pinv_1',
    });
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.toThrow(recovery);
    await expect(result).rejects.toBeInstanceOf(PlatformApiError);
    await expect(result).rejects.toMatchObject({
      status,
      code: error,
      body: JSON.stringify({ error }),
    });
  });

  it.each([
    ['forbidden', 'This deployment token cannot respond to invitations. Use your platform login.'],
    ['account suspended', 'This account is suspended. Contact the platform administrator.'],
  ])('preserves the server explanation for invitation rejection %s', async (code, message) => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const body = JSON.stringify({ error: code, message });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 403 })),
    );
    const error = await runProjectCommand(root, {
      subcommand: 'team',
      action: 'accept',
      invitationId: 'pinv_1',
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect(error).toMatchObject({ status: 403, code, body });
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain('auth logout');
  });

  it('explains an existing-member conflict from an older API', async () => {
    const root = rootWithPlatform('void');
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'user is already a project member' }, { status: 409 }),
      ),
    );
    await expect(
      runProjectCommand(root, {
        subcommand: 'team',
        action: 'invite',
        email: 'target@example.test',
        role: 'reader',
        projectSlug: '',
      }),
    ).rejects.toThrow('void project team role');
  });
});

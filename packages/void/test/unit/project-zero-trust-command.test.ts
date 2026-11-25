import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';
import { runProjectZeroTrustCommand } from '../../src/cli/project-zero-trust.ts';
import { captureOutput } from '../helpers/cli-command.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';

const roots: Array<string> = [];

function linkedProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-zero-trust-'));
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
    join(root, '.void', 'project.json'),
    JSON.stringify({
      platform: 'void',
      platformUrl: 'https://api.example.test',
      projectId: 'project_1',
      slug: 'linked-app',
    }),
  );
  return root;
}

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project Zero Trust command', () => {
  it('reports a pending public transition without claiming completion', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          project: {
            project_id: 'project_1',
            desired_protected: false,
            effective_protected: true,
            state: 'reconciling',
            last_error: null,
            updated_at: '2026-09-22T00:00:00Z',
          },
        }),
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'public',
      projectSlug: '',
      json: false,
    });
    expect(output.join('')).toContain('still in progress');
    expect(output.join('')).toContain('void project zero-trust reconcile');
    expect(output.join('')).not.toContain('linked-app is public');
    expect(output.join('')).not.toContain('✓');
  });
  it('reports an errored protection change without a success checkmark', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          project: {
            project_id: 'project_1',
            desired_protected: true,
            effective_protected: false,
            state: 'error',
            last_error: 'DNS verification failed',
            updated_at: '2026-10-06T00:00:00Z',
          },
        }),
      ),
    );
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'protect',
      projectSlug: '',
      json: false,
    });
    expect(output).toContain('needs attention');
    expect(output).not.toContain('✓');
    expect(output).not.toContain('is protected');
  });
  it('uses VOID_PROJECT without presenting an uninitialized state as public', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubEnv('VOID_PROJECT', 'selected-app');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'project_2',
            user_id: 'owner_1',
            slug: 'selected-app',
            type: 'worker',
            created_at: '2026-09-22T00:00:00Z',
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({
          available: true,
          platformStatus: 'ready',
          protectNewProjects: true,
          project: null,
        }),
      );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'status',
      projectSlug: '',
      json: false,
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.example.test/projects',
      'https://api.example.test/projects/project_2/zero-trust',
    ]);
    expect(output.join('')).toContain('Desired: not initialized');
    expect(output.join('')).toContain('Effective: not initialized');
    expect(output.join('')).not.toContain('Desired: public');
  });

  it.each([
    ['invalid_configuration', 'Zero Trust configuration is invalid'],
    ['configuring', 'still applying Zero Trust configuration'],
    ['ready', 'The platform administrator has disabled project Zero Trust.'],
  ])('explains an unavailable %s platform state', async (platformStatus, message) => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          available: false,
          platformStatus,
          protectNewProjects: true,
          project: {
            project_id: 'project_1',
            desired_protected: true,
            effective_protected: true,
            state: 'protected',
            last_error: null,
            updated_at: '2026-09-22T00:00:00Z',
          },
        }),
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'status',
      projectSlug: '',
      json: false,
    });

    const rendered = output.join('');
    expect(rendered).toContain(`Platform: ${platformStatus}`);
    expect(rendered).toContain(message);
    expect(rendered).toContain('Effective: protected');
    // The default for new projects is meaningful only for a readable configuration.
    expect(rendered.includes('Default for new projects: protected')).toBe(
      platformStatus !== 'invalid_configuration',
    );
  });

  it('sends project protection mutations through the command runner', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        project: {
          project_id: 'project_1',
          desired_protected: true,
          effective_protected: true,
          state: 'protected',
          last_error: null,
          updated_at: '2026-09-22T00:00:00Z',
        },
      }),
    );
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'protect',
      projectSlug: '',
      json: false,
    });
    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'public',
      projectSlug: '',
      json: false,
    });
    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'reconcile',
      projectSlug: '',
      json: false,
    });

    expect(fetchMock.mock.calls).toEqual([
      [
        'https://api.example.test/projects/project_1/zero-trust',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ protected: true }) }),
      ],
      [
        'https://api.example.test/projects/project_1/zero-trust',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ protected: false }) }),
      ],
      [
        'https://api.example.test/projects/project_1/zero-trust/reconcile',
        expect.objectContaining({ method: 'POST' }),
      ],
    ]);
  });

  it('removes C1 terminal controls from platform errors', async () => {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          available: true,
          platformStatus: 'ready',
          protectNewProjects: true,
          project: {
            project_id: 'project_1',
            desired_protected: true,
            effective_protected: false,
            state: 'error',
            last_error: 'before\u009b31mafter\u009dtitle',
            updated_at: '2026-09-22T00:00:00Z',
          },
        }),
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const output: Array<string> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await runProjectCommand(root, {
      subcommand: 'zero-trust',
      action: 'status',
      projectSlug: '',
      json: false,
    });

    const rendered = output.join('');
    expect(rendered).toContain('before 31mafter title');
    expect(rendered).not.toContain('\u009b');
    expect(rendered).not.toContain('\u009d');
  });
});

describe('project Zero Trust with a public request', () => {
  const project = { project_id: 'project_1', desired_protected: true, state: 'protected' };
  const request = (state: string) => ({
    id: 'spr_1',
    state,
    heldReason: 'timed_out',
    targetDeploymentId: 'dpl_9a1d',
    blockers: { count: 0, ids: [] },
  });
  function setup(fetchMock: unknown) {
    const root = linkedProject();
    vi.stubEnv('VOID_TOKEN', 'test-token');
    vi.stubEnv('VOID_API_URL', 'https://api.example.test');
    vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
    return root;
  }
  const base = { projectSlug: '', json: false } as const;
  const bypass = { ...base, subcommand: 'zero-trust', action: 'bypass' } as const;
  const args = { ...bypass, reason: 'Scanner down', yes: true };

  it('prints a held public as protected, never as public', async () => {
    const reply = { ok: true, project, publicRequest: request('waiting_scan') };
    const root = setup(vi.fn(async () => Response.json(reply, { status: 202 })));
    const out = captureOutput();
    await runProjectCommand(root, { ...bypass, action: 'public' });
    expect(out.output()).toContain('Waiting for a security scan of dpl_9a1d');
    expect(out.output()).not.toContain('is public');
  });

  it('bypasses with the reason and the request it saw, and refuses while urgent findings are open', async () => {
    let post = () => Response.json({ ok: true, project, publicRequest: request('bypassed') });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? post()
        : Response.json({
            available: true,
            platformStatus: 'ready',
            project,
            publicRequest: request('held_no_result'),
          }),
    );
    const root = setup(fetchMock);
    const out = captureOutput();
    await runProjectZeroTrustCommand(root, args, { interactive: false });
    const sent = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body;
    expect(JSON.parse(String(sent))).toEqual({ reason: 'Scanner down', requestId: 'spr_1' });
    expect(out.output()).toContain('Scan bypassed.');
    const blockers = { count: 1, ids: ['F-12'] };
    post = () =>
      Response.json(
        { error: 'security public request has urgent findings', blockers },
        { status: 409 },
      );
    await expect(runProjectZeroTrustCommand(root, args, { interactive: false })).rejects.toThrow(
      'A bypass skips only the scan, not open findings.',
    );
  });

  it('refuses security and bypass on a direct Cloudflare target before any request', async () => {
    const root = linkedProject();
    writeFileSync(join(root, '.void', 'project.json'), JSON.stringify({ platform: 'cloudflare' }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runProjectCommand(root, args)).rejects.toThrow(
      'only for projects hosted on a Void platform',
    );
    await expect(
      runProjectCommand(root, { ...base, subcommand: 'security', action: 'status' }),
    ).rejects.toThrow('Security audits are available only for projects hosted on a Void platform');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

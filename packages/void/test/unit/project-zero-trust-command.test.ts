import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';
import { runProjectZeroTrustCommand } from '../../src/cli/project-zero-trust.ts';
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

const project = {
  project_id: 'project_1',
  desired_protected: true,
  effective_protected: true,
  state: 'protected',
  last_error: null,
  updated_at: '2026-11-17T00:00:00Z',
};

function request(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'spr_1',
    state,
    heldReason: null,
    targetDeploymentId: 'dpl_9a1d',
    gateScanId: null,
    blockers: { count: 0, ids: [] },
    requestedAt: '2026-11-17T00:00:00Z',
    requestedByRole: 'admin',
    ...extra,
  };
}

function capture() {
  const output: Array<string> = [];
  const logged: Array<string> = [];
  vi.spyOn(console, 'log').mockImplementation((...parts) => {
    logged.push(parts.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  return { text: () => output.join(''), logged };
}

function setup(fetchMock: unknown) {
  const root = linkedProject();
  vi.stubEnv('VOID_TOKEN', 'test-token');
  vi.stubEnv('VOID_API_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', withPlatformDiscovery(fetchMock));
  return root;
}

const base = { subcommand: 'zero-trust', projectSlug: '', json: false } as const;

describe('project Zero Trust command with a public request', () => {
  it('prints a held 202 as protected, never as public', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          ok: true,
          project: {
            ...project,
            state: 'reconciling',
            last_error: 'old CLI line that must not print',
          },
          publicRequest: request('waiting_scan'),
          message:
            'Waiting for a security scan of dpl_9a1d before linked-app goes public. It stays protected by Zero Trust until the scan passes.',
        },
        { status: 202 },
      ),
    );
    const root = setup(fetchMock);
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'public' });
    const text = out.text();
    expect(text).toContain('Waiting for a security scan of dpl_9a1d');
    expect(text).toContain('stays protected');
    expect(text).not.toContain('is public');
    expect(text).not.toContain('old CLI line');
    expect(text).not.toContain('still in progress');
    expect(text).not.toContain('✓');
    expect(text).toContain('Check it:  void project zero-trust status');
  });

  it('prints the bypass command for a held public, which the platform message leaves out', async () => {
    const root = setup(
      vi.fn(async () =>
        Response.json(
          {
            ok: true,
            project: { ...project, state: 'reconciling' },
            publicRequest: request('held_no_result', { heldReason: 'timed_out' }),
            message: 'Stays protected: the security scan did not finish (timed out).',
          },
          { status: 202 },
        ),
      ),
    );
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'public' });
    const flat = stripVTControlCharacters(out.text())
      .split('\n')
      .join(' ')
      .split(' ')
      .filter(Boolean)
      .join(' ');
    expect(flat).toContain('Ask again with void project zero-trust public');
    expect(flat).toContain('void project zero-trust bypass --reason');
  });

  it('says protect canceled the open request (spec §11.4, edge #80)', async () => {
    const root = setup(
      vi.fn(async () => Response.json({ ok: true, project, publicRequest: request('canceled') })),
    );
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'protect' });
    expect(out.text()).toContain('Public request canceled. linked-app stays protected.');
    expect(out.text()).not.toContain('is protected by Zero Trust');
  });

  it('shows what a waiting request waits for, and the last bypass, in status', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/security')
        ? Response.json({ backlogFiles: 0, budget: null })
        : Response.json({
            available: true,
            platformStatus: 'ready',
            protectNewProjects: true,
            publicGate: true,
            publicRequest: request('waiting_scan', { heldReason: 'zero_trust_not_ready' }),
            lastBypass: {
              id: 'ssb_1',
              at: '2026-11-17T14:02:00.000Z',
              byRole: 'admin',
              reason: 'Launch day',
            },
            project,
          }),
    );
    const root = setup(fetchMock);
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'status' });
    const flat = stripVTControlCharacters(out.text())
      .split('│')
      .join(' ')
      .split('\n')
      .join(' ')
      .split(' ')
      .filter(Boolean)
      .join(' ');
    expect(flat).toContain(
      'Public request: Waiting for the Zero Trust protection of linked-app to be ready',
    );
    expect(flat).not.toContain('Waiting for a security scan');
    expect(flat).toContain('Last bypass: Nov 17, by a project admin ("Launch day")');
  });

  it('falls back to the local copy when the held reply has no message', async () => {
    const root = setup(
      vi.fn(async () =>
        Response.json(
          {
            ok: true,
            project: { ...project, state: 'reconciling' },
            publicRequest: request('held_findings', { blockers: { count: 1, ids: ['F-12'] } }),
          },
          { status: 202 },
        ),
      ),
    );
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'public' });
    expect(out.text()).toContain('1 urgent finding must be resolved');
    expect(out.text()).toContain('F-12');
    expect(out.text()).not.toContain('bypass the scan');
  });

  it('prints the held reply as JSON with the stored state', async () => {
    const root = setup(
      vi.fn(async () =>
        Response.json(
          {
            ok: true,
            project: { ...project, state: 'reconciling', last_error: 'old line' },
            publicRequest: request('waiting_scan'),
            message: 'Waiting.',
          },
          { status: 202 },
        ),
      ),
    );
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'public', json: true });
    expect(out.logged).toHaveLength(1);
    const printed = JSON.parse(out.logged[0]!);
    expect(printed.held).toBe(true);
    expect(printed.project).toMatchObject({ state: 'protected', last_error: null });
    expect(printed.publicRequest.state).toBe('waiting_scan');
  });

  it('keeps an old platform reply exactly as before with --json off', async () => {
    const root = setup(
      vi.fn(async () =>
        Response.json({
          ok: true,
          project: {
            ...project,
            desired_protected: false,
            effective_protected: false,
            state: 'public',
          },
        }),
      ),
    );
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'public' });
    expect(out.text()).toContain('linked-app is public.');
  });

  it('shows the request block in status', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/security')
        ? Response.json({ backlogFiles: 0, budget: null })
        : Response.json({
            available: true,
            platformStatus: 'ready',
            protectNewProjects: true,
            publicGate: true,
            publicRequest: request('held_no_result', { heldReason: 'timed_out' }),
            project,
          }),
    );
    const root = setup(fetchMock);
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'status' });
    // CI forces colour: strip it so the box borders split cleanly.
    const flat = stripVTControlCharacters(out.text())
      .split('│')
      .join(' ')
      .split('\n')
      .join(' ')
      .split(' ')
      .filter(Boolean)
      .join(' ');
    expect(flat).toContain(
      'Public request: Stays protected: the security scan did not finish (timed out)',
    );
    expect(flat).toContain('void project zero-trust bypass --reason');
  });

  it('prints status as JSON', async () => {
    const reply = {
      available: true,
      platformStatus: 'ready',
      protectNewProjects: true,
      publicRequest: null,
      project,
    };
    const root = setup(vi.fn(async () => Response.json(reply)));
    const out = capture();
    await runProjectCommand(root, { ...base, action: 'status', json: true });
    expect(JSON.parse(out.logged[0]!)).toEqual(reply);
  });
});

describe('project Zero Trust bypass', () => {
  function bypassFetch(
    bypass: () => Response,
    open = request('held_no_result', { heldReason: 'timed_out' }),
  ) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/public-request/bypass') && init?.method === 'POST'
        ? bypass()
        : Response.json({
            available: true,
            platformStatus: 'ready',
            protectNewProjects: true,
            publicRequest: open,
            project,
          }),
    );
  }
  const goingPublic = () =>
    Response.json({
      ok: true,
      project: { ...project, desired_protected: false, state: 'reconciling' },
      publicRequest: request('bypassed'),
      skipped: 'the scan did not finish (timed out)',
    });
  const args = { ...base, action: 'bypass', reason: 'Scanner down', yes: false } as const;

  it('confirms what is skipped, then posts the reason', async () => {
    const fetchMock = bypassFetch(goingPublic);
    const root = setup(fetchMock);
    const out = capture();
    const ask = vi.fn(async () => true);
    await runProjectZeroTrustCommand(root, args, { interactive: true, confirm: ask });
    expect(ask).toHaveBeenCalledWith('Bypass the scan and make linked-app public?');
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    // The request it saw goes along, so one closed meanwhile is refused (edge #72).
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      reason: 'Scanner down',
      requestId: 'spr_1',
    });
    expect(out.text()).toContain(
      'This skips the security scan. The scan of dpl_9a1d did not finish (timed out).',
    );
    expect(out.text()).toContain('Your platform admins get an email with your reason');
    expect(out.text()).toContain(
      'Scan bypassed. linked-app is going public (Zero Trust update in progress).',
    );
  });

  it('changes nothing when the prompt is declined', async () => {
    const fetchMock = bypassFetch(goingPublic);
    const root = setup(fetchMock);
    const out = capture();
    await runProjectZeroTrustCommand(root, args, { interactive: true, confirm: async () => false });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(out.text()).toContain('Nothing was changed.');
  });

  it('needs --yes when it cannot prompt', async () => {
    const fetchMock = bypassFetch(goingPublic);
    const root = setup(fetchMock);
    capture();
    await expect(runProjectZeroTrustCommand(root, args, { interactive: false })).rejects.toThrow(
      'Add --yes',
    );
    await expect(
      runProjectZeroTrustCommand(root, { ...args, json: true }, { interactive: true }),
    ).rejects.toThrow('Add --yes');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('skips the prompt with --yes and prints JSON', async () => {
    const root = setup(bypassFetch(goingPublic));
    const out = capture();
    await runProjectZeroTrustCommand(
      root,
      { ...args, yes: true, json: true },
      { interactive: false },
    );
    const printed = JSON.parse(out.logged[0]!);
    expect(printed.publicRequest.state).toBe('bypassed');
    expect(printed.skipped).toContain('did not finish');
  });

  it('names the open urgent findings on a 409', async () => {
    const root = setup(
      bypassFetch(
        () =>
          Response.json(
            {
              error: 'security public request has urgent findings',
              message: 'platform copy',
              blockers: { count: 2, ids: ['F-12', 'F-15'] },
            },
            { status: 409 },
          ),
        request('held_findings', { blockers: { count: 2, ids: ['F-12', 'F-15'] } }),
      ),
    );
    capture();
    const failure = await runProjectZeroTrustCommand(root, { ...args, yes: true }).catch(
      (error: unknown) => error,
    );
    expect((failure as Error).message).toContain(
      'linked-app has 2 urgent findings open (F-12, F-15). A bypass skips only the scan, not open findings.',
    );
    expect((failure as Error).message).toContain('→ void project security list --urgent');
    // --json keeps the platform code, the status and the blockers (cli-main spreads details).
    expect(failure).toMatchObject({
      code: 'security public request has urgent findings',
      status: 409,
      details: { blockers: { count: 2, ids: ['F-12', 'F-15'] } },
    });
  });

  it('says there is no request to bypass', async () => {
    const root = setup(bypassFetch(goingPublic, null as never));
    capture();
    await expect(runProjectZeroTrustCommand(root, { ...args, yes: true })).rejects.toThrow(
      'linked-app has no public request to bypass. Run: void project zero-trust public',
    );
  });

  it('says a protect closed the request it saw, with the 409 code (edge #72)', async () => {
    const closed = (state: string) => () =>
      Response.json(
        {
          error: 'public request closed',
          message: `The public request is already ${state}.`,
          state,
        },
        { status: 409 },
      );
    const root = setup(bypassFetch(closed('canceled')));
    capture();
    const failure = await runProjectZeroTrustCommand(root, { ...args, yes: true }).catch(
      (error: unknown) => error,
    );
    expect((failure as Error).message).toBe(
      'project: Public request canceled, so nothing was bypassed. linked-app stays protected.',
    );
    expect(failure).toMatchObject({
      code: 'public request closed',
      status: 409,
      details: { state: 'canceled' },
    });
    expect((failure as Error).message).not.toContain('void project zero-trust public');

    const passed = setup(bypassFetch(closed('passed')));
    await expect(runProjectZeroTrustCommand(passed, { ...args, yes: true })).rejects.toThrow(
      'The security scan already passed, so nothing was bypassed. linked-app is going public.',
    );
  });

  it('names an old platform that has no bypass route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response('Not Found', { status: 404 })
        : Response.json({
            available: true,
            platformStatus: 'ready',
            protectNewProjects: true,
            project,
          }),
    );
    const root = setup(fetchMock);
    capture();
    await expect(runProjectZeroTrustCommand(root, { ...args, yes: true })).rejects.toThrow(
      'does not support security audits',
    );
  });
});

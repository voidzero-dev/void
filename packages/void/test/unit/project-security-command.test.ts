import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { parseProjectArgs } from '../../src/cli/project-args.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';
import { runProjectSecurityCommand } from '../../src/cli/project-security.ts';
import type { ProjectSecurityStatus } from '../../src/cli/security-api-types.ts';

const roots: Array<string> = [];

function linked(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-project-security-'));
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
      slug: 'acme-web',
    }),
  );
  vi.stubEnv('VOID_TOKEN', 'test-token');
  vi.stubEnv('VOID_API_URL', 'https://api.example.test');
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

const scan = {
  id: 'ss_1',
  status: 'succeeded',
  statusReason: null,
  failureCause: null,
  refusalCategory: null,
  trigger: 'deploy',
  deploymentId: 'dpl_8f2c',
  baseDeploymentId: 'dpl_7c20',
  coverageLabel: 'changes since dpl_7c20 · source diff · 14 files',
  backlogFiles: 0,
  filesScanned: 14,
  model: '@cf/x',
  meteredUsd: 0.4,
  startedAt: '2026-11-17T10:00:00.000Z',
  finishedAt: '2026-11-17T10:09:00.000Z',
  createdAt: '2026-11-17T10:00:00.000Z',
};

const status: ProjectSecurityStatus = {
  policy: {
    mode: 'public',
    applies: true,
    reason: 'not protected by Zero Trust',
    publicGate: false,
  },
  urgent: {
    count: 2,
    counts: { critical: 1, high: 1 },
    oldestFirstSeenAt: '2026-11-10T00:00:00.000Z',
    findings: [
      { id: 'F-12', severity: 'critical' },
      { id: 'F-15', severity: 'high' },
    ],
    more: 0,
    detail: 'full',
  },
  model: {
    id: '@cf/x',
    requested: '@cf/x',
    source: 'default',
    thirdParty: false,
    noticeAccepted: false,
    pendingDefault: null,
  },
  budget: {
    capUsd: 100,
    capSource: 'own',
    ceilingUsd: 100,
    spentUsd: 12.4,
    month: '2026-11',
    resetsAt: '2026-12-01T00:00:00.000Z',
  },
  lastScan: scan,
  lastSuccessfulScan: scan,
  deploysSinceLastSuccess: 0,
  backlogFiles: 0,
  counts: {
    open: { critical: 1, high: 1, medium: 1, low: 0, informational: 0 },
    leads: 3,
    resolved: 0,
    urgent: 2,
  },
  publicRequest: null,
};

function capture() {
  const out: Array<string> = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  return out;
}

function route(handlers: Record<string, () => Response>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/.well-known/void-platform') {
        return Response.json({});
      }
      calls.push({
        method,
        path: url.pathname + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const handler = handlers[`${method} ${url.pathname}`];
      return handler ? handler() : new Response('404 Not Found', { status: 404 });
    }),
  );
  return calls;
}

const run = (root: string, args: Array<string>) => runProjectCommand(root, parseProjectArgs(args));

describe('project security command', () => {
  it('prints the status in the spec layout', async () => {
    const root = linked();
    route({ 'GET /projects/project_1/security': () => Response.json(status) });
    const out = capture();
    await run(root, ['security', 'status']);
    const text = out.join('\n');
    expect(text).toContain('acme-web · security');
    expect(text).toContain('2 open (1 critical, 1 high) · oldest Nov 10');
    expect(text).toContain('applies: not protected by Zero Trust (Public projects only)');
    expect(text).toContain('$12.40 of $100.00 this month (project cap) · resets Dec 1');
    expect(text).toContain('succeeded · dpl_8f2c · 9 min');
    expect(text).toContain('2 urgent · 1 other · 3 leads');
  });

  it('prints a held public request on the status', async () => {
    const root = linked();
    route({
      'GET /projects/project_1/security': () =>
        Response.json({
          ...status,
          publicRequest: {
            id: 'spr_1',
            state: 'held_findings',
            heldReason: null,
            targetDeploymentId: 'dpl_9a1d',
            gateScanId: null,
            blockers: { count: 2, ids: ['F-12', 'F-15'] },
            requestedAt: '2026-11-17T14:02:00.000Z',
            requestedByRole: 'admin',
          },
        }),
    });
    const out = capture();
    await run(root, ['security', 'status']);
    expect(out.join('\n')).toContain(
      '2 urgent findings must be resolved before Zero Trust is turned off (F-12, F-15)',
    );
  });

  it('strips terminal escapes from model text', async () => {
    const root = linked();
    route({
      'GET /projects/project_1/security/findings': () =>
        Response.json({
          findings: [
            {
              id: 'F-1',
              verdict: 'confirmed',
              severity: 'high',
              state: 'open',
              urgent: true,
              revision: 1,
              title: 'bad \u001b[31mred\u001b]0;x\u0007 title',
            },
          ],
          nextCursor: null,
        }),
    });
    const out = capture();
    await run(root, ['security', 'list']);
    const text = out.join('\n');
    expect(text).toContain('F-1');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });

  it('resolves with the revision it read and prints what is still urgent', async () => {
    const root = linked();
    const calls = route({
      'GET /projects/project_1/security/findings/F-12': () =>
        Response.json({
          finding: {
            id: 'F-12',
            verdict: 'confirmed',
            severity: 'critical',
            state: 'open',
            urgent: true,
            revision: 4,
          },
        }),
      'POST /projects/project_1/security/findings/F-12/resolve': () =>
        Response.json({
          ok: true,
          id: 'F-12',
          state: 'resolved',
          resolution: 'fixed',
          revision: 5,
        }),
      'GET /projects/project_1/security': () =>
        Response.json({
          ...status,
          urgent: { ...status.urgent, count: 1, findings: [{ id: 'F-15', severity: 'high' }] },
        }),
    });
    const out = capture();
    await run(root, [
      'security',
      'resolve',
      'F-12',
      '--reason',
      'fixed',
      '--comment',
      'Bound params',
    ]);
    const text = out.join('\n');
    expect(text).toContain('✓ F-12 resolved (fixed). The next scan will check that the fix holds.');
    expect(text).toContain('Still open and urgent: F-15 (high).');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      reason: 'fixed',
      comment: 'Bound params',
      expectedRevision: 4,
    });
  });

  it('fails when a resolve is refused as changed', async () => {
    const root = linked();
    route({
      'GET /projects/project_1/security/findings/F-12': () =>
        Response.json({
          finding: {
            id: 'F-12',
            verdict: 'confirmed',
            severity: 'high',
            state: 'open',
            urgent: true,
            revision: 4,
          },
        }),
      'POST /projects/project_1/security/findings/F-12/resolve': () =>
        Response.json(
          {
            error: 'finding changed',
            message: 'F-12 changed while you were working on it: resolved (fixed).',
          },
          { status: 409 },
        ),
    });
    const out = capture();
    await expect(
      run(root, ['security', 'resolve', 'F-12', '--reason', 'fixed', '--comment', 'x']),
    ).rejects.toThrow('1 of 1');
    expect(out.join('\n')).toContain('F-12 changed while you were working on it');
  });

  it('shows the platform ceiling copy for a budget above the limit', async () => {
    const root = linked();
    route({
      'PUT /projects/project_1/security/budget': () =>
        Response.json(
          {
            error: 'security budget above platform limit',
            message:
              'The platform limits each project to $100.00 / month. Ask your platform admin to raise it for acme-web: void platform security budget --project acme-web --usd 150',
          },
          { status: 422 },
        ),
    });
    await expect(run(root, ['security', 'budget', '--usd', '150'])).rejects.toThrow(
      'The platform limits each project to $100.00 / month. Ask your platform admin',
    );
  });

  it('accepts the provider notice with the version the platform names', async () => {
    const root = linked();
    let puts = 0;
    const calls = route({
      'PUT /projects/project_1/security/model': () =>
        ++puts === 1
          ? Response.json(
              {
                error: 'provider notice not accepted',
                message: 'read it',
                version: 3,
                notice: ['Run by Anthropic.'],
              },
              { status: 422 },
            )
          : Response.json({
              ok: true,
              model: {
                ...status.model,
                id: 'anthropic/claude-x',
                source: 'project',
                thirdParty: true,
              },
            }),
    });
    const out = capture();
    await run(root, ['security', 'model', 'anthropic/claude-x', '--accept-provider-notice']);
    expect(out.join('\n')).toContain('Run by Anthropic.');
    expect(
      calls.map(
        (c) => (c.body as { acceptProviderNoticeVersion?: number }).acceptProviderNoticeVersion,
      ),
    ).toEqual([0, 3]);
  });

  it('says an old platform does not support security audits', async () => {
    const root = linked();
    route({});
    await expect(run(root, ['security', 'status'])).rejects.toThrow(
      'does not support security audits',
    );
  });

  it('opens the page link only on a terminal', async () => {
    const root = linked();
    route({
      'POST /projects/project_1/security/page-link': () =>
        Response.json({
          url: 'https://api.example.test/security/projects/acme-web?t=abc',
          expiresAt: '2026-11-17T10:15:00.000Z',
        }),
    });
    capture();
    const openUrl = vi.fn();
    await runProjectSecurityCommand(root, parseProjectArgs(['security', 'open']) as never, {
      openUrl,
      interactive: false,
    });
    expect(openUrl).not.toHaveBeenCalled();
    await runProjectSecurityCommand(root, parseProjectArgs(['security', 'open']) as never, {
      openUrl,
      interactive: true,
    });
    expect(openUrl).toHaveBeenCalledWith(
      'https://api.example.test/security/projects/acme-web?t=abc',
    );
  });
});

const F = '/projects/project_1/security/findings';
const finding = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  verdict: 'confirmed',
  severity: 'high',
  state: 'open',
  urgent: true,
  revision: 2,
  title: `title ${id}`,
  file: 'src/a.ts',
  line: 3,
  ...extra,
});

describe('project security command paths', () => {
  it('lists findings, hides leads with a note and shows them with --leads', async () => {
    const root = linked();
    route({
      [`GET ${F}`]: () =>
        Response.json({
          findings: [finding('F-1'), finding('F-2', { verdict: 'needs_validation' })],
          nextCursor: null,
        }),
    });
    const out = capture();
    await run(root, ['security', 'list']);
    let text = out.join('\n');
    expect(text).toContain('F-1');
    expect(text).not.toContain('F-2 ');
    expect(text).toContain('1 lead is hidden. Show them with --leads.');
    out.length = 0;
    await run(root, ['security', 'list', '--leads']);
    text = out.join('\n');
    expect(text).toContain('F-2');
    expect(text).toContain('lead');
    expect(text).not.toContain('hidden');
  });

  it('stops listing at 500 findings and says so', async () => {
    const root = linked();
    const calls = route({
      [`GET ${F}`]: () =>
        Response.json({
          findings: Array.from({ length: 100 }, (_, i) => finding(`F-${i + 1}`)),
          nextCursor: '100',
        }),
    });
    const out = capture();
    await run(root, ['security', 'list']);
    expect(calls).toHaveLength(5);
    expect(out.join('\n')).toContain('Showing the first 500.');
  });

  it('shows the full detail, and only the summary to a reader', async () => {
    const root = linked();
    route({
      [`GET ${F}/F-1`]: () =>
        Response.json({
          finding: finding('F-1', { evidence: 'EVID', fix: 'FIXTEXT' }),
          events: [
            {
              createdAt: '2026-11-17T10:00:00.000Z',
              action: 'comment',
              actorKind: 'user',
              actor: 'ana',
              actorRole: 'admin',
              comment: 'looked',
            },
          ],
        }),
      [`GET ${F}/F-2`]: () =>
        Response.json({ finding: { ...finding('F-2'), title: undefined, file: undefined } }),
    });
    const out = capture();
    await run(root, ['security', 'show', 'F-1']);
    let text = out.join('\n');
    expect(text).toContain('title F-1');
    expect(text).toContain('EVID');
    expect(text).toContain('FIXTEXT');
    expect(text).toContain('ana');
    out.length = 0;
    await run(root, ['security', 'show', 'F-2']);
    text = out.join('\n');
    expect(text).toContain('Readers see the id, severity and state');
    expect(text).not.toContain('Evidence');
  });

  it('adds a comment', async () => {
    const root = linked();
    const calls = route({
      [`POST ${F}/F-3/comments`]: () => Response.json({ ok: true, id: 'F-3' }),
    });
    const out = capture();
    await run(root, ['security', 'comment', 'F-3', 'checked by hand']);
    expect(out.join('\n')).toContain('Comment added to F-3.');
    expect(calls[0]?.body).toEqual({ text: 'checked by hand' });
  });

  it('reopens with the revision it read first', async () => {
    const root = linked();
    const calls = route({
      [`GET ${F}/F-4`]: () => Response.json({ finding: finding('F-4', { revision: 7 }) }),
      [`POST ${F}/F-4/reopen`]: () => Response.json({ ok: true, id: 'F-4' }),
    });
    const out = capture();
    await run(root, ['security', 'reopen', 'F-4', '--comment', 'still reachable']);
    expect(out.join('\n')).toContain('F-4 reopened.');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1]?.body).toEqual({ comment: 'still reachable', expectedRevision: 7 });
  });

  it('lists scans and notes older ones', async () => {
    const root = linked();
    const calls = route({
      'GET /projects/project_1/security/scans': () =>
        Response.json({ scans: [scan], nextCursor: '9' }),
    });
    const out = capture();
    await run(root, ['security', 'scans', '--limit', '5']);
    const text = out.join('\n');
    expect(calls[0]?.path).toBe('/projects/project_1/security/scans?limit=5');
    expect(text).toContain('dpl_8f2c');
    expect(text).toContain('$0.40');
    expect(text).toContain('Older scans exist.');
  });

  it('shows the model, then sets it, resets it to the default', async () => {
    const root = linked();
    const calls = route({
      'GET /projects/project_1/security': () => Response.json(status),
      'PUT /projects/project_1/security/model': () =>
        Response.json({ ok: true, model: { ...status.model, id: '@cf/y' } }),
    });
    const out = capture();
    await run(root, ['security', 'model']);
    expect(out.join('\n')).toContain('provider notice not accepted');
    out.length = 0;
    await run(root, ['security', 'model', '@cf/y']);
    expect(out.join('\n')).toContain('scans now use @cf/y');
    expect(calls.at(-1)?.body).toEqual({ model: '@cf/y' });
    out.length = 0;
    await run(root, ['security', 'model', '--default']);
    expect(out.join('\n')).toContain('uses the platform default model (@cf/y)');
    expect(calls.at(-1)?.body).toEqual({ model: null });
  });

  it('shows the budget, sets it with --usd and clears it with --off', async () => {
    const root = linked();
    const calls = route({
      'GET /projects/project_1/security': () => Response.json(status),
      'PUT /projects/project_1/security/budget': () =>
        Response.json({ ok: true, budget: { ...status.budget, capUsd: 100 } }),
    });
    const out = capture();
    await run(root, ['security', 'budget']);
    expect(out.join('\n')).toContain('$100.00 / month (set for this project)');
    out.length = 0;
    await run(root, ['security', 'budget', '--usd', '40']);
    expect(out.join('\n')).toContain('scan budget set to $40.00 / month');
    expect(calls.at(-1)?.body).toEqual({ monthlyUsd: 40 });
    out.length = 0;
    await run(root, ['security', 'budget', '--off']);
    expect(out.join('\n')).toContain('own cap cleared');
    expect(calls.at(-1)?.body).toEqual({ monthlyUsd: null });
  });

  it('resolves several ids, keeps going after one fails, then fails the command', async () => {
    const root = linked();
    const calls = route({
      [`GET ${F}/F-1`]: () => Response.json({ finding: finding('F-1', { revision: 1 }) }),
      [`GET ${F}/F-2`]: () => Response.json({ finding: finding('F-2', { revision: 1 }) }),
      [`GET ${F}/F-3`]: () => Response.json({ finding: finding('F-3', { revision: 1 }) }),
      [`POST ${F}/F-1/resolve`]: () =>
        Response.json({ ok: true, id: 'F-1', state: 'resolved', resolution: 'accepted_risk' }),
      [`POST ${F}/F-2/resolve`]: () =>
        Response.json({ error: 'finding changed', message: 'F-2 changed.' }, { status: 409 }),
      [`POST ${F}/F-3/resolve`]: () =>
        Response.json({ ok: true, id: 'F-3', state: 'resolved', resolution: 'accepted_risk' }),
      'GET /projects/project_1/security': () => Response.json(status),
    });
    const out = capture();
    await expect(
      run(root, [
        'security',
        'resolve',
        'F-1,F-2,F-3',
        '--reason',
        'accepted-risk',
        '--comment',
        'ok',
      ]),
    ).rejects.toThrow('1 of 3 findings were not resolved');
    const text = out.join('\n');
    expect(text).toContain('F-1 resolved (accepted risk)');
    expect(text).toContain('F-2: F-2 changed.');
    expect(text).toContain('F-3 resolved (accepted risk)');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3);
  });

  it('prints one JSON document with --json', async () => {
    const root = linked();
    route({ 'GET /projects/project_1/security': () => Response.json(status) });
    const out = capture();
    await run(root, ['security', 'status', '--json']);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ policy: { mode: 'public' }, counts: { leads: 3 } });
    route({ [`GET ${F}`]: () => Response.json({ findings: [finding('F-1')], nextCursor: null }) });
    out.length = 0;
    await run(root, ['security', 'list', '--json']);
    expect(JSON.parse(out[0]!)).toMatchObject({ findings: [{ id: 'F-1' }], more: false });
  });
});

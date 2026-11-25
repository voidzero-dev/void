import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseProjectArgs } from '../../src/cli/project-args.ts';
import { runProjectCommand } from '../../src/cli/project-cmd.ts';
import { captureOutput, linkedProject } from '../helpers/cli-command.ts';
import { withPlatformDiscovery } from '../helpers/platform-discovery.ts';
import { securityStatus } from '../helpers/security-status.ts';

const linked = () => linkedProject({ slug: 'acme-web' });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const status = securityStatus({
  urgent: {
    count: 1,
    counts: { critical: 1, high: 0 },
    oldestFirstSeenAt: '2026-11-10T00:00:00.000Z',
    findings: [{ id: 'F-12', severity: 'critical' }],
    more: 0,
    detail: 'full',
  },
  budget: {
    capUsd: 100,
    capSource: 'own',
    ceilingUsd: 100,
    spentUsd: 12.4,
    month: '2026-11-01',
    resetsAt: '2026-12-01T00:00:00.000Z',
  },
});

function route(handlers: Record<string, () => Response>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    withPlatformDiscovery(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname + url.search, body });
      const handler = handlers[`${method} ${url.pathname}`];
      return handler ? handler() : new Response('404 Not Found', { status: 404 });
    }),
  );
  return calls;
}

const run = (root: string, args: Array<string>) => runProjectCommand(root, parseProjectArgs(args));
const S = '/projects/project_1/security';
const F = `${S}/findings`;
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

describe('void project security', () => {
  it('prints the status, one JSON document with --json, and names an old platform', async () => {
    const root = linked();
    route({ [`GET ${S}`]: () => Response.json(status) });
    const out = captureOutput();
    await run(root, ['security', 'status']);
    expect(out.output()).toContain('1 open (1 critical) · oldest Nov 10');
    expect(out.output()).toContain('$12.40 of $100.00 this month (project cap) · resets Dec 1');
    out.clear();
    await run(root, ['security', 'status', '--json']);
    expect(JSON.parse(out.output())).toMatchObject({
      policy: { mode: 'all' },
      counts: { leads: 3 },
    });
    route({});
    await expect(run(root, ['security', 'status'])).rejects.toThrow(
      'does not support security audits',
    );
  });

  it('lists findings without leads and shows one in full', async () => {
    const root = linked();
    route({
      [`GET ${F}`]: () =>
        Response.json({
          findings: [finding('F-1'), finding('F-2', { verdict: 'needs_validation' })],
          nextCursor: null,
        }),
      [`GET ${F}/F-1`]: () =>
        Response.json({ finding: finding('F-1', { evidence: 'EVID', fix: 'FIXTEXT' }) }),
    });
    const out = captureOutput();
    await run(root, ['security', 'list']);
    expect(out.output()).toContain('F-1');
    expect(out.output()).toContain('1 lead is hidden. Show them with --leads.');
    out.clear();
    await run(root, ['security', 'show', 'F-1']);
    expect(out.output()).toContain('EVID');
    expect(out.output()).toContain('FIXTEXT');
  });

  it('resolves with the revision it read, keeps going after a refusal, then fails', async () => {
    const root = linked();
    const calls = route({
      [`GET ${F}/F-1`]: () => Response.json({ finding: finding('F-1', { revision: 4 }) }),
      [`GET ${F}/F-2`]: () => Response.json({ finding: finding('F-2') }),
      [`POST ${F}/F-1/resolve`]: () =>
        Response.json({ ok: true, id: 'F-1', state: 'resolved', resolution: 'fixed' }),
      [`POST ${F}/F-2/resolve`]: () =>
        Response.json({ error: 'finding changed', message: 'F-2 changed.' }, { status: 409 }),
      [`GET ${S}`]: () => Response.json(status),
    });
    const out = captureOutput();
    await expect(
      run(root, ['security', 'resolve', 'F-1,F-2', '--reason', 'fixed', '--comment', 'Bound']),
    ).rejects.toThrow('1 of 2 findings were not resolved');
    expect(out.output()).toContain('F-1 resolved (fixed)');
    expect(out.output()).toContain('F-2: F-2 changed.');
    expect(calls.find((c) => c.path === `${F}/F-1/resolve`)?.body).toEqual({
      reason: 'fixed',
      comment: 'Bound',
      expectedRevision: 4,
    });
  });

  it('sets the budget and accepts a provider notice only with the version the platform names', async () => {
    const root = linked();
    let puts = 0;
    const calls = route({
      [`PUT ${S}/budget`]: () => Response.json({ ok: true, budget: status.budget }),
      [`PUT ${S}/model`]: () =>
        ++puts === 1
          ? Response.json(
              { error: 'provider notice not accepted', version: 3, notice: ['Run by Anthropic.'] },
              { status: 422 },
            )
          : Response.json({ ok: true, model: { ...status.model, id: 'anthropic/claude-x' } }),
    });
    const out = captureOutput();
    await run(root, ['security', 'budget', '--usd', '40']);
    expect(out.output()).toContain('scan budget set to $40.00 / month');
    expect(calls[0]?.body).toEqual({ monthlyUsd: 40 });
    await run(root, ['security', 'model', 'anthropic/claude-x', '--accept-provider-notice']);
    expect(out.output()).toContain('Run by Anthropic.');
    const versions = calls
      .slice(1)
      .map((c) => (c.body as { acceptProviderNoticeVersion?: number }).acceptProviderNoticeVersion);
    expect(versions).toEqual([0, 3]);
  });

  it('previews a scan, needs --yes without a terminal, then queues it', async () => {
    const root = linked();
    let posts = 0;
    const calls = route({
      [`POST ${S}/scans`]: () =>
        ++posts === 1
          ? Response.json({ dryRun: true, deploymentId: 'dpl_9a1d', tier: 'full', model: '@cf/x' })
          : Response.json(
              {
                ok: true,
                scanId: 'ss_new',
                deploymentId: 'dpl_9a1d',
                tier: 'full',
                model: '@cf/x',
              },
              { status: 202 },
            ),
    });
    await expect(run(root, ['security', 'scan', '--json'])).rejects.toThrow('Add --yes');
    posts = 0;
    const out = captureOutput();
    await run(root, ['security', 'scan', '--yes']);
    expect(calls.map((c) => c.body)).toEqual([{ dryRun: true }, { dryRun: true }, {}]);
    expect(out.output()).toContain('✓ Full scan ss_new of dpl_9a1d queued.');
  });
});

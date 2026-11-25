import { describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError } from '../../src/cli/client.ts';
import type { PlatformClient } from '../../src/cli/client.ts';
import {
  formatProjectStatusSecurityLine,
  printDeploySecurityNotice,
} from '../../src/cli/deploy-security-notice.ts';
import type { CliLogger } from '../../src/cli/log-file.ts';
import type { ProjectSecurityStatus } from '../../src/cli/security-api-types.ts';
import { scanSummary as scan, securityStatus as status } from '../helpers/security-status.ts';

const urgent = (
  n: number,
  detail: 'full' | 'counts' = 'full',
): ProjectSecurityStatus['urgent'] => ({
  count: n,
  counts: { critical: Math.min(n, 1), high: Math.max(0, n - 1) },
  oldestFirstSeenAt: '2026-11-01T00:00:00.000Z',
  more: 0,
  detail,
  findings: Array.from({ length: Math.min(n, 5) }, (_, index) =>
    detail === 'full'
      ? {
          id: `F-${index + 1}`,
          severity: index === 0 ? 'high' : index === 1 ? 'critical' : 'high',
          title: `Title ${index + 1}\u001b[31m red`,
          file: 'src/a.ts',
          line: 4,
        }
      : { id: `F-${index + 1}`, severity: 'high' },
  ),
});

async function run(
  reply: () => Promise<unknown>,
  extra: {
    env?: NodeJS.ProcessEnv;
    slug?: string;
    timeoutMs?: number;
    cliLog?: CliLogger;
  } = {},
) {
  const lines: Array<string> = [];
  const getProjectSecurity = vi.fn(reply);
  await printDeploySecurityNotice({
    client: { getProjectSecurity } as unknown as PlatformClient,
    projectId: 'project_1',
    slug: extra.slug ?? 'acme-web',
    deploymentId: 'dpl_9a1d',
    cliLog: extra.cliLog,
    env: extra.env ?? {},
    timeoutMs: extra.timeoutMs,
    write: (line) => lines.push(line),
  });
  return { lines, getProjectSecurity };
}

describe('deploy security notice', () => {
  it('prints the queued scan line', async () => {
    const { lines } = await run(async () => status());
    expect(lines.join('\n')).toContain(
      'Security scan queued · model @cf/deepseek-ai/deepseek-v4.1-flash-1017 · usually 5–15 min',
    );
    expect(lines.at(-1)).toBe('  Check it:  void project security status');
  });

  it('names the third-party provider and a pending default', async () => {
    const reply = status({
      model: {
        id: 'anthropic/claude-opus-5.5',
        requested: 'anthropic/claude-opus-5.5',
        source: 'project',
        thirdParty: true,
        noticeAccepted: true,
        pendingDefault: 'openai/gpt-6',
      },
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).toContain('Run by Anthropic: its usage policy applies and it may refuse.');
    expect(text).toContain('Platform default is openai/gpt-6. Accept to use it:');
  });

  it('says what a public request waits for', async () => {
    const reply = status({
      publicRequest: {
        id: 'pr_1',
        state: 'waiting_scan',
        heldReason: null,
        targetDeploymentId: 'dpl_9a1d',
        gateScanId: 'ss_1',
        blockers: { count: 0, ids: [] },
        requestedAt: '2026-11-17T10:00:00.000Z',
        requestedByRole: 'admin',
      },
    });
    expect((await run(async () => reply)).lines.join('\n')).toContain(
      'acme-web stays protected by Zero Trust until this scan passes (public request).',
    );
  });

  it('prints the budget, protected and no-change lines', async () => {
    const own = status({
      lastScan: scan({ status: 'skipped', statusReason: 'budget' }),
      budget: {
        capUsd: 40,
        capSource: 'own',
        ceilingUsd: 100,
        spentUsd: 40,
        month: '2026-11',
        resetsAt: '2026-12-01T00:00:00.000Z',
      },
    });
    const ownText = (await run(async () => own)).lines.join('\n');
    // The wording of each cause is in the budgetSkipCopy table (project-security-command.test.ts).
    expect(ownText).toContain('  Not security-scanned: ');
    expect(ownText).toContain('Resets Dec 1.');
    expect(ownText).toContain('void project security budget --usd 100');

    const platform = status({
      lastScan: scan({ status: 'skipped', statusReason: 'budget' }),
      budget: {
        capUsd: null,
        capSource: 'none',
        ceilingUsd: null,
        spentUsd: 0,
        month: '2026-11',
        resetsAt: '2026-12-01T00:00:00.000Z',
      },
    });
    expect((await run(async () => platform)).lines.join('\n')).toContain(
      'Resets Dec 1. Ask your platform admin.',
    );

    const protectedText = (
      await run(async () =>
        status({ lastScan: scan({ status: 'skipped', statusReason: 'protected' }) }),
      )
    ).lines.join('\n');
    expect(protectedText).toContain('project is protected by Zero Trust');

    const same = status({ lastScan: scan({ status: 'succeeded', statusReason: 'no_changes' }) });
    expect((await run(async () => same)).lines.join('\n')).toContain(
      'Security scan: no code changes since dpl_7c20.',
    );
  });

  it('warns when the last scan did not finish', async () => {
    const reply = status({
      lastScan: scan({ id: 'ss_0', status: 'refused', deploymentId: 'dpl_7c20' }),
      lastSuccessfulScan: scan({ status: 'succeeded', deploymentId: 'dpl_5c01' }),
      deploysSinceLastSuccess: 2,
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).toContain(
      'Warning: the security scan of dpl_7c20 did not finish (refused by model).',
    );
    expect(text).toContain('2 deploys since the last successful scan (dpl_5c01).');
    const one = status({ ...reply, deploysSinceLastSuccess: 1 });
    expect((await run(async () => one)).lines.join('\n')).not.toContain('deploys since');
  });

  it('warns about the scan before this deploy, next to the new queued scan (spec §6.5)', async () => {
    const reply = status({
      lastScan: scan(),
      previousScan: scan({
        id: 'ss_0',
        status: 'incomplete',
        statusReason: 'turn_cap',
        deploymentId: 'dpl_7c20',
      }),
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).toContain('Security scan queued');
    expect(text).toContain(
      'Warning: the security scan of dpl_7c20 did not finish (partial: turn_cap).',
    );
    const failed = status({
      previousScan: scan({ id: 'ss_0', status: 'failed', statusReason: 'bad_output' }),
    });
    // A previous scan of this same deployment is not "the last deploy".
    expect((await run(async () => failed)).lines.join('\n')).not.toContain('Warning');
  });

  it('keeps the protected line when the policy does not apply to a protected project', async () => {
    const reply = status({
      policy: {
        mode: 'public',
        applies: false,
        reason: 'this project is protected by Zero Trust',
        publicGate: false,
      },
      lastScan: scan({ status: 'skipped', statusReason: 'protected' }),
    });
    expect((await run(async () => reply)).lines).toContain(
      '  Not security-scanned: project is protected by Zero Trust and the platform scans public projects only.',
    );
  });

  const budget = (overrides: Partial<NonNullable<ProjectSecurityStatus['budget']>> = {}) => ({
    capUsd: 0.1,
    capSource: 'own' as const,
    ceilingUsd: null,
    spentUsd: 0.38,
    month: '2026-11',
    resetsAt: '2026-12-01T00:00:00.000Z',
    scanReserveUsd: 0.25,
    ...overrides,
  });

  it('prints the budget lines, not "queued", when the cap is used up at deploy end', async () => {
    const text = (await run(async () => status({ budget: budget() }))).lines.join('\n');
    expect(text).not.toContain('Security scan queued');
    expect(text).toContain('Not security-scanned: ');
    expect(text).toContain('used up ($0.38 of $0.10)');
    expect(text).toContain('void project security budget --usd <amount>');
    // One scan's worst case does not fit in what is left either.
    const short = status({ budget: budget({ capUsd: 0.5, spentUsd: 0.3 }) });
    expect((await run(async () => short)).lines.join('\n')).toContain(
      'more than is left of this project',
    );
  });

  it("names the per-project limit and the operator command with the project id (capSource 'limit')", async () => {
    const reply = status({
      lastScan: scan({ status: 'skipped', statusReason: 'budget', budgetCause: 'project_cap' }),
      budget: budget({
        capUsd: 0.2,
        capSource: 'limit',
        ceilingUsd: 0.2,
        ceilingSource: 'project',
        spentUsd: 0.41,
      }),
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).not.toContain("the platform's monthly scan budget");
    expect(text).toContain('used up ($0.41 of $0.20)');
    expect(text).toContain('void platform security budget --project project_1 --usd 1');
  });

  it('says the next deploy is scanned when the cap was raised since the skip', async () => {
    const reply = status({
      lastScan: scan({ status: 'skipped', statusReason: 'budget', budgetCause: 'project_cap' }),
      budget: budget({ capUsd: 5 }),
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).toContain('Not security-scanned: ');
    expect(text).toContain('it was raised since');
    expect(text).toContain('The next deploy is scanned.');
  });

  it('explains a reserve above the cap instead of "used up" (project_reserve)', async () => {
    const reply = status({
      lastScan: scan({ status: 'skipped', statusReason: 'budget', budgetCause: 'project_reserve' }),
      budget: budget({ capUsd: 1.5, spentUsd: 0, scanReserveUsd: 2.04 }),
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).not.toContain('used up');
    expect(text).toContain('can cost up to $2.04');
    expect(text).toContain('pick a cheaper model');
  });

  it('lists urgent rows for a user session, critical first, with ANSI stripped', async () => {
    const reply = status({ urgent: urgent(2), lastScan: null });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).toContain(
      '⚠ 2 urgent security findings are open in acme-web (1 critical, 1 high):',
    );
    expect(text.indexOf('F-2')).toBeLessThan(text.indexOf('F-1 '));
    expect(text).toContain('Title 2 red');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('src/a.ts:4');
    expect(text).toContain('Your deploy went out.');
    expect(text).toContain('void project security show F-2');
    expect(text).toContain('A project admin or owner can resolve them.');
    expect(text).not.toContain('Fixed?');
  });

  it('names the resolve command for a caller who can resolve (settings)', async () => {
    const reply = status({ urgent: urgent(2), lastScan: null, canResolve: true });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).toContain(
      '    Fixed?  void project security resolve F-2 --reason fixed --comment "…"',
    );
    expect(text).not.toContain('A project admin or owner can resolve them.');
  });

  it('cuts to five rows and counts the rest', async () => {
    const big = urgent(8);
    const text = (await run(async () => status({ urgent: big, lastScan: null }))).lines.join('\n');
    expect(text).toContain('… and 3 more:  void project security list --urgent');
    expect(text).not.toContain('F-6');
  });

  it('prints counts and ids only when the server says counts', async () => {
    const text = (
      await run(async () => status({ urgent: urgent(2, 'counts'), lastScan: null }))
    ).lines.join('\n');
    expect(text).toContain('2 urgent security findings are open (1 critical, 1 high): F-1, F-2');
    expect(text).toContain('Details are not printed in CI logs.');
    expect(text).not.toContain('Title');
  });

  it.each([{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }])(
    'drops to counts under %j even when the server sent titles',
    async (env) => {
      const text = (
        await run(async () => status({ urgent: urgent(2), lastScan: null }), { env })
      ).lines.join('\n');
      expect(text).toContain('Details are not printed in CI logs.');
      expect(text).not.toContain('Title');
      expect(text).not.toContain('src/a.ts');
    },
  );

  it('prints the public request line under the urgent block', async () => {
    const reply = status({
      urgent: urgent(1),
      lastScan: null,
      publicRequest: {
        id: 'pr_1',
        state: 'held_findings',
        heldReason: 'findings',
        targetDeploymentId: 'dpl_9a1d',
        gateScanId: null,
        blockers: { count: 1, ids: ['F-1'] },
        requestedAt: '2026-11-17T10:00:00.000Z',
        requestedByRole: 'admin',
      },
    });
    expect((await run(async () => reply)).lines.join('\n')).toContain(
      'acme-web stays protected by Zero Trust until these are resolved (public request).',
    );
  });

  it('prints nothing when the policy is off or for a preview project', async () => {
    const off = status({
      policy: { mode: 'disabled', applies: false, reason: 'off', publicGate: false },
      urgent: urgent(2),
    });
    expect((await run(async () => off)).lines).toEqual([]);
    expect(
      (await run(async () => status(), { slug: 'preview-abc' })).getProjectSecurity,
    ).not.toHaveBeenCalled();
  });

  it('still prints urgent findings when routing was not published but the deploy is live', async () => {
    const reply = status({ urgent: urgent(1), lastScan: null });
    expect((await run(async () => reply)).lines.join('\n')).toContain('Your deploy went out.');
  });

  it('lists rows oldest first inside a severity', async () => {
    const found = (id: string, firstSeenAt: string) => ({ id, severity: 'high', firstSeenAt });
    const reply = status({
      lastScan: null,
      urgent: {
        ...urgent(3),
        findings: [
          found('F-7', '2026-11-05T00:00:00.000Z'),
          found('F-3', '2026-11-01T00:00:00.000Z'),
          found('F-5', '2026-11-03T00:00:00.000Z'),
        ],
      },
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text.indexOf('F-3')).toBeLessThan(text.indexOf('F-5'));
    expect(text.indexOf('F-5')).toBeLessThan(text.indexOf('F-7 '));
  });

  it('hints at a possible duplicate and a finding not seen in the latest scan', async () => {
    const reply = status({
      lastScan: null,
      urgent: {
        ...urgent(2),
        findings: [
          {
            id: 'F-1',
            severity: 'high',
            title: 'a',
            possibleDuplicateOf: { id: 'F-9', resolution: 'wont_fix' },
          },
          { id: 'F-2', severity: 'high', title: 'b', notSeenInLatest: true },
        ],
      },
    });
    const text = (await run(async () => reply)).lines.join('\n');
    expect(text).toContain('(possible duplicate of F-9, resolved wont fix)');
    expect(text).toContain('(not seen in latest scan; may already be fixed)');
  });

  it('writes the cliLog entries', async () => {
    const cliLog = { info: vi.fn(), debug: vi.fn() } as unknown as CliLogger;
    await run(async () => status({ urgent: urgent(2) }), { cliLog });
    expect(cliLog.info).toHaveBeenCalledWith('security_notice', {
      printed: true,
      urgent: 2,
      scan: 'queued',
    });
    const quiet = { info: vi.fn(), debug: vi.fn() } as unknown as CliLogger;
    await run(() => Promise.reject(new PlatformApiError('nope', 403, '')), { cliLog: quiet });
    expect(quiet.debug).toHaveBeenCalledWith('security_notice_skipped', { reason: 'http_403' });
    await run(async () => ({ ok: true }), { cliLog: quiet });
    expect(quiet.debug).toHaveBeenCalledWith('security_notice_skipped', {
      reason: 'unexpected_reply',
    });
  });

  it.each([
    ['404', () => Promise.reject(new PlatformApiError('not found', 404, ''))],
    ['401', () => Promise.reject(new PlatformApiError('no session', 401, ''))],
    ['403', () => Promise.reject(new PlatformApiError('forbidden', 403, ''))],
    [
      'non-JSON 404',
      () => Promise.reject(new PlatformApiError('Not found', 404, '<html>not found</html>')),
    ],
    ['500', () => Promise.reject(new PlatformApiError('boom', 500, ''))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['non-object reply', () => Promise.resolve('nope')],
    ['old reply shape', () => Promise.resolve({ ok: true })],
  ])('prints nothing and keeps the exit code on a %s', async (_name, reply) => {
    const before = process.exitCode;
    const { lines } = await run(reply);
    expect(lines).toEqual([]);
    expect(process.exitCode).toBe(before);
  });

  it('gives up on a read that never answers', async () => {
    const before = process.exitCode;
    vi.useFakeTimers();
    try {
      const done = run(() => new Promise(() => {}), { timeoutMs: 20 });
      // The hard stop is 250 ms after the abort.
      await vi.advanceTimersByTimeAsync(270);
      expect((await done).lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    expect(process.exitCode).toBe(before);
  });
});

describe('project status security line', () => {
  it('shows urgent count and leads, or none', () => {
    expect(formatProjectStatusSecurityLine('acme-web', status({ urgent: urgent(2) }))).toBe(
      'Security  2 urgent open · 3 leads → void project security list --urgent',
    );
    expect(formatProjectStatusSecurityLine('acme-web', status())).toBe(
      'Security  no urgent findings open',
    );
  });

  it('is empty when audits are off or the project is a preview', () => {
    const off = status({
      policy: { mode: 'disabled', applies: false, reason: 'off', publicGate: false },
    });
    expect(formatProjectStatusSecurityLine('acme-web', off)).toBeNull();
    expect(formatProjectStatusSecurityLine('preview-x', status())).toBeNull();
  });
});

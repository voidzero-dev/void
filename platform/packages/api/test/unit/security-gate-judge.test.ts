import { describe, expect, it } from 'vite-plus/test';
import { publicRequestCopy } from '../../src/security/public-gate-copy.ts';
import { bypassSkips, judgeGate } from '../../src/security/public-gate-judge.ts';
import type { GateJudgeInput, GateScanFacts } from '../../src/security/public-gate-judge.ts';

const scan = (patch: Partial<GateScanFacts> = {}): GateScanFacts => ({
  id: 'ss_1',
  status: 'succeeded',
  statusReason: null,
  failureCause: null,
  backlogFiles: 0,
  capped: false,
  unreadFiles: false,
  ...patch,
});

const input = (patch: Partial<GateJudgeInput> = {}): GateJudgeInput => ({
  targetDeploymentId: 'dpl_1',
  activeDeploymentId: 'dpl_1',
  deploymentMoving: false,
  zeroTrustReady: true,
  scan: scan(),
  hasInput: true,
  urgent: [],
  unproven: [],
  ...patch,
});

describe('judgeGate', () => {
  const nothingLive = { targetDeploymentId: '', activeDeploymentId: null, scan: null };

  it('passes a clean scan of the live deployment, or a first deploy that never went live', () => {
    expect(judgeGate(input())).toEqual({ kind: 'pass', scanId: 'ss_1' });
    expect(judgeGate(input({ scan: scan({ unreadFiles: false }) }))).toEqual({
      kind: 'pass',
      scanId: 'ss_1',
    });
    expect(judgeGate(input(nothingLive))).toEqual({ kind: 'pass', scanId: null });
  });

  const failed = (patch: Partial<GateScanFacts> = {}) => scan({ status: 'failed', ...patch });
  const budget = scan({ status: 'skipped', statusReason: 'budget' });
  const inputMissing = failed({ statusReason: 'input_missing' });
  it.each<[string, Partial<GateJudgeInput>, Record<string, unknown>]>([
    // Waiting on the deployment or Zero Trust.
    [
      'deployment moving',
      { deploymentMoving: true },
      { state: 'waiting_scan', reason: 'deployment_moving' },
    ],
    ['live is not the target', { activeDeploymentId: 'dpl_2' }, { reason: 'deployment_moving' }],
    [
      'first deploy still moving',
      { ...nothingLive, deploymentMoving: true },
      { reason: 'deployment_moving' },
    ],
    [
      'Zero Trust not ready',
      { zeroTrustReady: false },
      { state: 'waiting_scan', reason: 'zero_trust_not_ready' },
    ],
    // Urgent findings win over anything about the scan.
    [
      'urgent findings while running',
      { urgent: ['F-2'], unproven: ['F-2', 'F-3'], scan: scan({ status: 'running' }) },
      { state: 'held_findings', blockers: ['F-2', 'F-3'] },
    ],
    // A scan in flight, or none yet.
    ...(['pending_input', 'queued', 'running'] as const).map(
      (status): [string, Partial<GateJudgeInput>, Record<string, unknown>] => [
        `scan ${status}`,
        { scan: scan({ status }) },
        { state: 'waiting_scan', reason: 'scan_waiting', queue: false },
      ],
    ),
    ['no scan, input kept', { scan: null }, { state: 'waiting_scan', queue: true }],
    [
      'no scan, no input',
      { scan: null, hasInput: false },
      { state: 'needs_deploy', reason: 'no_input' },
    ],
    // A fixed claim with no scan to prove it.
    [
      'unproven fix, no scan',
      { scan: null, unproven: ['F-1'] },
      { state: 'needs_deploy', reason: 'unproven_fix', queue: false },
    ],
    ['unproven fix, clean scan', { unproven: ['F-1'] }, { state: 'needs_deploy' }],
    // A scan with no result.
    ['failed', { scan: failed() }, { state: 'held_no_result', reason: 'failed' }],
    [
      'failed installation',
      { scan: failed({ failureCause: 'installation' }) },
      { state: 'held_no_result', reason: 'failed_installation' },
    ],
    ['skipped budget', { scan: budget }, { state: 'held_no_result', reason: 'skipped_budget' }],
    ['failed input missing', { scan: inputMissing }, { state: 'needs_deploy' }],
    // #54: no result and no code left to scan again.
    [
      'skipped budget, no input (#54)',
      { scan: budget, hasInput: false },
      { state: 'needs_deploy', reason: 'no_input', queue: false, scanId: 'ss_1' },
    ],
    // Unproven fixed claims block a scan with no result.
    [
      'failed project, unproven fix',
      { scan: failed({ failureCause: 'project' }), unproven: ['F-6'] },
      { state: 'held_no_result', reason: 'failed_project', blockers: ['F-6'] },
    ],
    [
      'input missing, unproven fix',
      { scan: inputMissing, unproven: ['F-6'] },
      { state: 'needs_deploy', blockers: ['F-6'] },
    ],
    // Backlog, capped and unread scans; without input only a deploy moves them on.
    [
      'backlog left',
      { scan: scan({ backlogFiles: 4 }) },
      { state: 'waiting_scan', reason: 'backlog', queue: true },
    ],
    [
      'backlog left, no input',
      { scan: scan({ backlogFiles: 4 }), hasInput: false },
      { state: 'needs_deploy', reason: 'no_input', queue: false, scanId: 'ss_1' },
    ],
    [
      'capped',
      { scan: scan({ capped: true }) },
      { state: 'held_no_result', reason: 'findings_capped' },
    ],
    [
      'capped, no input',
      { scan: scan({ capped: true }), hasInput: false },
      { state: 'needs_deploy', reason: 'no_input' },
    ],
    // Unread files are never queued again.
    [
      'unread files',
      { scan: scan({ unreadFiles: true }) },
      { state: 'held_no_result', reason: 'unread_files', queue: false },
    ],
    [
      'unread files, no input',
      { scan: scan({ unreadFiles: true }), hasInput: false },
      { state: 'needs_deploy', reason: 'no_input' },
    ],
  ])('%s', (_name, patch, expected) => {
    expect(judgeGate(input(patch))).toMatchObject(expected);
  });
});

describe('bypassSkips and copy', () => {
  it('names what a bypass skips, and nothing for findings', () => {
    expect(bypassSkips('held_findings', null, [])).toBeNull();
    expect(bypassSkips('waiting_scan', null, [])).toContain('not finished');
    expect(bypassSkips('needs_deploy', 'unproven_fix', ['F-1'])).toContain('F-1');
    expect(bypassSkips('held_no_result', 'failed_project', [])).toBe(
      'the scan did not finish (failed project)',
    );
    expect(bypassSkips('held_no_result', 'unread_files', [])).toBe(
      'the scan could not read some project files',
    );
    expect(bypassSkips('held_no_result', 'failed_project', ['F-6'])).toBe(
      'the scan did not finish (failed project); the fix of F-6 is not checked by a scan yet',
    );
  });

  const base = { slug: 'shop', reason: null, blockerIds: ['F-1'], deploymentId: 'dpl_1' };
  it.each([
    ['waiting_scan', 'Waiting for a security scan of dpl_1'],
    ['held_findings', 'Stays protected: 1 urgent finding must be resolved'],
    ['needs_deploy', 'Stays protected: the live deployment dpl_1 cannot be scanned'],
    ['held_no_result', 'Stays protected: the security scan did not finish (no result)'],
    ['passed', 'Security scan passed'],
    ['bypassed', 'Public without a clean scan'],
    ['canceled', 'Public request canceled'],
  ] as const)('writes a line for %s', (state, start) => {
    expect(publicRequestCopy({ ...base, state }).startsWith(start)).toBe(true);
  });

  it('names the blockers and the unread-files hold', () => {
    expect(publicRequestCopy({ ...base, state: 'held_findings' })).toContain('F-1');
    const unread = publicRequestCopy({ ...base, state: 'held_no_result', reason: 'unread_files' });
    expect(unread).toContain('could not read some project files');
    expect(unread).not.toContain('Ask again');
  });

  it('says what a waiting request waits for (edge #75, #86)', () => {
    const base = {
      slug: 'shop',
      blockerIds: [],
      deploymentId: 'dpl_1',
      state: 'waiting_scan',
    } as const;
    expect(publicRequestCopy({ ...base, reason: 'scan_queued' })).toBe(
      'Waiting for a security scan of dpl_1 before shop goes public. It stays protected by Zero Trust until the scan passes.',
    );
    expect(publicRequestCopy({ ...base, reason: 'deployment_moving' })).toBe(
      'Waiting for the new deployment to go live before shop goes public. It stays protected by Zero Trust until the scan of that deployment passes.',
    );
    const notReady = publicRequestCopy({ ...base, reason: 'zero_trust_not_ready' });
    expect(notReady).toContain('Waiting for the Zero Trust protection of shop to be ready');
    expect(notReady).not.toContain('security scan of');
  });
});

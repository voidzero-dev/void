import { describe, expect, it } from 'vite-plus/test';
import { publicRequestCopy } from '../../src/security/public-gate-copy.ts';
import {
  bypassSkips,
  judgeGate,
  type GateJudgeInput,
  type GateScanFacts,
} from '../../src/security/public-gate-judge.ts';

const scan = (patch: Partial<GateScanFacts> = {}): GateScanFacts => ({
  id: 'ss_1',
  status: 'succeeded',
  statusReason: null,
  failureCause: null,
  backlogFiles: 0,
  capped: false,
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
  it('passes a clean succeeded scan of the live deployment', () => {
    expect(judgeGate(input())).toEqual({ kind: 'pass', scanId: 'ss_1' });
  });

  it('waits while the deployment moves or the live one is not the target', () => {
    expect(judgeGate(input({ deploymentMoving: true }))).toMatchObject({
      state: 'waiting_scan',
      reason: 'deployment_moving',
    });
    expect(judgeGate(input({ activeDeploymentId: 'dpl_2' }))).toMatchObject({
      reason: 'deployment_moving',
    });
  });

  it('waits while Zero Trust is not ready', () => {
    expect(judgeGate(input({ zeroTrustReady: false }))).toMatchObject({
      state: 'waiting_scan',
      reason: 'zero_trust_not_ready',
    });
  });

  it('holds for urgent findings before anything about the scan', () => {
    expect(
      judgeGate(
        input({ urgent: ['F-2'], unproven: ['F-2', 'F-3'], scan: scan({ status: 'running' }) }),
      ),
    ).toMatchObject({ state: 'held_findings', blockers: ['F-2', 'F-3'] });
  });

  it('waits for a scan that is queued or running', () => {
    for (const status of ['pending_input', 'queued', 'running'] as const) {
      expect(judgeGate(input({ scan: scan({ status }) }))).toMatchObject({
        state: 'waiting_scan',
        reason: 'scan_waiting',
        queue: false,
      });
    }
  });

  it('queues a scan when there is none and the input is kept', () => {
    expect(judgeGate(input({ scan: null }))).toMatchObject({
      state: 'waiting_scan',
      queue: true,
    });
    expect(judgeGate(input({ scan: null, hasInput: false }))).toMatchObject({
      state: 'needs_deploy',
      reason: 'no_input',
    });
  });

  it('asks for a deploy when a fixed claim has no scan to prove it', () => {
    expect(judgeGate(input({ scan: null, unproven: ['F-1'] }))).toMatchObject({
      state: 'needs_deploy',
      reason: 'unproven_fix',
      queue: false,
    });
    expect(judgeGate(input({ unproven: ['F-1'] }))).toMatchObject({ state: 'needs_deploy' });
  });

  it('holds with no result when the scan did not succeed', () => {
    expect(judgeGate(input({ scan: scan({ status: 'failed' }) }))).toMatchObject({
      state: 'held_no_result',
      reason: 'failed',
    });
    expect(
      judgeGate(input({ scan: scan({ status: 'failed', failureCause: 'installation' }) })),
    ).toMatchObject({ state: 'held_no_result', reason: 'failed_installation' });
    expect(
      judgeGate(input({ scan: scan({ status: 'skipped', statusReason: 'budget' }) })),
    ).toMatchObject({ state: 'held_no_result', reason: 'skipped_budget' });
    expect(
      judgeGate(input({ scan: scan({ status: 'failed', statusReason: 'input_missing' }) })),
    ).toMatchObject({ state: 'needs_deploy' });
  });

  it('queues the next part while a backlog is left, and holds a capped scan', () => {
    expect(judgeGate(input({ scan: scan({ backlogFiles: 4 }) }))).toMatchObject({
      state: 'waiting_scan',
      reason: 'backlog',
      queue: true,
    });
    // No input left to scan the next part from: only a deploy moves it on.
    expect(judgeGate(input({ scan: scan({ backlogFiles: 4 }), hasInput: false }))).toMatchObject({
      state: 'needs_deploy',
      reason: 'no_input',
      queue: false,
      scanId: 'ss_1',
    });
    expect(judgeGate(input({ scan: scan({ capped: true }) }))).toMatchObject({
      state: 'held_no_result',
      reason: 'findings_capped',
    });
    expect(judgeGate(input({ scan: scan({ capped: true }), hasInput: false }))).toMatchObject({
      state: 'needs_deploy',
      reason: 'no_input',
    });
  });

  it('asks for a deploy when a scan with no result left no code to scan again (#54)', () => {
    expect(
      judgeGate(
        input({ scan: scan({ status: 'skipped', statusReason: 'budget' }), hasInput: false }),
      ),
    ).toMatchObject({ state: 'needs_deploy', reason: 'no_input', queue: false, scanId: 'ss_1' });
  });

  it('lists unproven fixed claims as blockers of a scan with no result', () => {
    expect(
      judgeGate(
        input({ scan: scan({ status: 'failed', failureCause: 'project' }), unproven: ['F-6'] }),
      ),
    ).toMatchObject({ state: 'held_no_result', reason: 'failed_project', blockers: ['F-6'] });
    expect(
      judgeGate(
        input({
          scan: scan({ status: 'failed', statusReason: 'input_missing' }),
          unproven: ['F-6'],
        }),
      ),
    ).toMatchObject({ state: 'needs_deploy', blockers: ['F-6'] });
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
    expect(bypassSkips('held_no_result', 'failed_project', ['F-6'])).toBe(
      'the scan did not finish (failed project); the fix of F-6 is not checked by a scan yet',
    );
  });

  it('writes a line for every state', () => {
    const base = { slug: 'shop', reason: null, blockerIds: ['F-1'], deploymentId: 'dpl_1' };
    for (const state of [
      'waiting_scan',
      'held_findings',
      'needs_deploy',
      'held_no_result',
      'passed',
      'bypassed',
      'canceled',
    ] as const) {
      expect(publicRequestCopy({ ...base, state })).toContain('');
      expect(publicRequestCopy({ ...base, state }).length).toBeGreaterThan(10);
    }
    expect(publicRequestCopy({ ...base, state: 'held_findings' })).toContain('F-1');
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

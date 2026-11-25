import { expect, it } from 'vite-plus/test';
import { judgeGate } from '../../src/security/public-gate-judge.ts';
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

// I6: only a clean, complete scan of the live deployment lets a request go public.
it.each<[string, Partial<GateJudgeInput>, Record<string, unknown>]>([
  ['clean scan of the live deployment', {}, { kind: 'pass', scanId: 'ss_1' }],
  [
    'first deploy that never went live',
    { targetDeploymentId: '', activeDeploymentId: null, scan: null },
    { kind: 'pass', scanId: null },
  ],
  ['live is not the target', { activeDeploymentId: 'dpl_2' }, { reason: 'deployment_moving' }],
  ['Zero Trust not ready', { zeroTrustReady: false }, { reason: 'zero_trust_not_ready' }],
  [
    'urgent findings win over a running scan',
    { urgent: ['F-2'], unproven: ['F-2', 'F-3'], scan: scan({ status: 'running' }) },
    { state: 'held_findings', blockers: ['F-2', 'F-3'] },
  ],
  ['scan running', { scan: scan({ status: 'running' }) }, { state: 'waiting_scan' }],
  [
    'unproven fix with a clean scan',
    { unproven: ['F-1'] },
    { state: 'needs_deploy', reason: 'unproven_fix' },
  ],
  [
    'failed scan',
    { scan: scan({ status: 'failed' }) },
    { state: 'held_no_result', reason: 'failed' },
  ],
  [
    'skipped for budget, no input left',
    { scan: scan({ status: 'skipped', statusReason: 'budget' }), hasInput: false },
    { state: 'needs_deploy', reason: 'no_input' },
  ],
  ['backlog left', { scan: scan({ backlogFiles: 4 }) }, { state: 'waiting_scan', queue: true }],
  ['capped', { scan: scan({ capped: true }) }, { reason: 'findings_capped' }],
  ['unread files', { scan: scan({ unreadFiles: true }) }, { reason: 'unread_files', queue: false }],
])('judgeGate: %s', (_name, patch, expected) => {
  expect(judgeGate(input(patch))).toMatchObject(expected);
});

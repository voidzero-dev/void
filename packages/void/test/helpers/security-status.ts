import type {
  ProjectSecurityStatus,
  SecurityScanSummary,
} from '../../src/cli/security-api-types.ts';

/** A queued deploy scan of `dpl_9a1d`; pass what the test is about. */
export function scanSummary(overrides: Partial<SecurityScanSummary> = {}): SecurityScanSummary {
  return {
    id: 'ss_1',
    status: 'queued',
    statusReason: null,
    failureCause: null,
    refusalCategory: null,
    trigger: 'deploy',
    deploymentId: 'dpl_9a1d',
    baseDeploymentId: 'dpl_7c20',
    coverageLabel: null,
    backlogFiles: 0,
    filesScanned: 0,
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    meteredUsd: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    ...overrides,
  };
}

/** A project the platform scans, with nothing urgent, no budget and a queued scan. */
export function securityStatus(
  overrides: Partial<ProjectSecurityStatus> = {},
): ProjectSecurityStatus {
  return {
    policy: {
      mode: 'all',
      applies: true,
      reason: 'the platform scans all projects',
      publicGate: false,
    },
    urgent: {
      count: 0,
      counts: { critical: 0, high: 0 },
      oldestFirstSeenAt: null,
      findings: [],
      more: 0,
      detail: 'full',
    },
    model: {
      id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      requested: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      source: 'default',
      thirdParty: false,
      noticeAccepted: false,
      pendingDefault: null,
    },
    budget: null,
    lastScan: scanSummary(),
    lastSuccessfulScan: null,
    deploysSinceLastSuccess: null,
    backlogFiles: 0,
    counts: { open: {}, leads: 3, resolved: 0, urgent: 0 },
    publicRequest: null,
    ...overrides,
  };
}

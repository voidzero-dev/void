import { describe, expect, it } from 'vite-plus/test';
import {
  chooseSecurityTier,
  SECURITY_FULL_REASON_NOTES,
  securityCoverageLabel,
} from '../../src/security/input/tier.ts';

describe('chooseSecurityTier', () => {
  it('runs a full scan when there is no succeeded scan yet (edge #5)', () => {
    expect(
      chooseSecurityTier({ trigger: 'deploy', baseDeploymentId: null, baseSnapshot: false }),
    ).toEqual({ tier: 'full', fullReason: 'first_scan' });
  });

  it('runs a full scan when the base snapshot is gone', () => {
    expect(
      chooseSecurityTier({ trigger: 'deploy', baseDeploymentId: 'dpl_1', baseSnapshot: false }),
    ).toEqual({ tier: 'full', fullReason: 'no_usable_base' });
  });

  it('diffs the built output against a stored base (edges #3, #9)', () => {
    expect(
      chooseSecurityTier({ trigger: 'deploy', baseDeploymentId: 'dpl_1', baseSnapshot: true }),
    ).toEqual({ tier: 'built_diff', fullReason: null });
    expect(
      chooseSecurityTier({ trigger: 'gate', baseDeploymentId: 'dpl_1', baseSnapshot: true }),
    ).toEqual({ tier: 'built_diff', fullReason: null });
  });

  it('takes the source diff only when its checks passed', () => {
    expect(
      chooseSecurityTier({
        trigger: 'deploy',
        baseDeploymentId: 'dpl_1',
        baseSnapshot: true,
        sourceDiff: true,
      }).tier,
    ).toBe('source_diff');
  });

  it('always runs an operator rescan in full (edge #43)', () => {
    expect(
      chooseSecurityTier({ trigger: 'rescan', baseDeploymentId: 'dpl_1', baseSnapshot: true }),
    ).toEqual({ tier: 'full', fullReason: 'rescan' });
  });
});

describe('securityCoverageLabel', () => {
  const row = {
    tier: 'built_diff' as const,
    coverage: 'complete' as const,
    coverageNotes: [] as Array<string>,
    filesScanned: 12,
    backlogFiles: 0,
  };

  it('names the tier and the file count', () => {
    expect(securityCoverageLabel(row)).toBe('built-output diff · 12 files');
    expect(securityCoverageLabel({ ...row, tier: 'source_diff', filesScanned: 1 })).toBe(
      'source diff · 1 file',
    );
  });

  it('says why a full scan ran', () => {
    const full = { ...row, tier: 'full' as const };
    expect(
      securityCoverageLabel({ ...full, coverageNotes: [SECURITY_FULL_REASON_NOTES.first_scan] }),
    ).toBe('full scan (first scan)');
    expect(
      securityCoverageLabel({
        ...full,
        coverageNotes: [SECURITY_FULL_REASON_NOTES.no_usable_base],
      }),
    ).toBe('full scan (no usable base)');
    expect(
      securityCoverageLabel({ ...full, coverageNotes: [SECURITY_FULL_REASON_NOTES.rescan] }),
    ).toBe('full scan (rescan)');
    expect(
      securityCoverageLabel({ ...full, coverageNotes: [SECURITY_FULL_REASON_NOTES.gate_recheck] }),
    ).toBe('full scan (re-check)');
  });

  it('shows the backlog (edge #13)', () => {
    expect(
      securityCoverageLabel({ ...row, coverage: 'partial', filesScanned: 400, backlogFiles: 4600 }),
    ).toBe('built-output diff · 400 files · partial (backlog 4,600 files)');
    expect(securityCoverageLabel({ ...row, coverage: 'partial' })).toBe(
      'built-output diff · 12 files · partial',
    );
  });

  it('has no label before the input is built', () => {
    expect(securityCoverageLabel({ ...row, tier: null })).toBeNull();
  });
});

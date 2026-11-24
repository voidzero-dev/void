import { describe, expect, it } from 'vite-plus/test';
import { scanStatusCopy, type SecurityPageData } from '../../src/security/project-page.ts';

type Budget = NonNullable<SecurityPageData['status']['budget']>;

function page(cause: string | null, budget: Partial<Budget> | null): SecurityPageData {
  return {
    status: {
      lastScan: { status: 'skipped', statusReason: 'budget', budgetCause: cause },
      lastSuccessfulScan: null,
      model: { id: '@cf/zai-org/glm-5.3' },
      budget:
        budget === null
          ? null
          : {
              capUsd: 0.2,
              capSource: 'limit',
              ceilingUsd: 0.2,
              ceilingSource: 'project',
              spentUsd: 0.41,
              month: '2026-11-01',
              resetsAt: '2026-12-01T00:00:00.000Z',
              scanReserveUsd: 2.04,
              ...budget,
            },
    },
  } as unknown as SecurityPageData;
}

describe('project page budget copy (spec §11.4, §16.3)', () => {
  it("names this project's cap when the per-project limit skipped the scan", () => {
    expect(scanStatusCopy(page('project_cap', {}))).toBe(
      "Not scanned: this project's monthly scan budget is used up ($0.41 of $0.20). Resets Dec 1.",
    );
    expect(scanStatusCopy(page('platform_cap', { capUsd: null, capSource: 'none' }))).toBe(
      "Not scanned: the platform's monthly scan budget is used up. Resets Dec 1. Your platform admin can raise it.",
    );
  });

  it('says the next deploy is scanned after a raise, and explains a reserve above the cap', () => {
    expect(scanStatusCopy(page('project_cap', { capUsd: 5 }))).toBe(
      "Not scanned: this project's monthly scan budget was used up. It was raised since ($0.41 of $5.00 used); the next deploy is scanned.",
    );
    expect(scanStatusCopy(page('project_reserve', { capUsd: 1.5, spentUsd: 0 }))).toBe(
      "Not scanned: one scan with @cf/zai-org/glm-5.3 can cost up to $2.04, more than is left of this project's monthly scan budget ($1.50 of $1.50). Raise the cap or pick a cheaper model.",
    );
    expect(scanStatusCopy(page('project_cap', null))).toBe(
      'Not scanned: the monthly scan budget is used up.',
    );
  });
});

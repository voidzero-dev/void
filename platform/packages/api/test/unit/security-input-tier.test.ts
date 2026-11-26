import { expect, it } from 'vite-plus/test';
import { chooseSecurityTier } from '../../src/security/input/tier.ts';

it('picks full with no base, the built diff against a base, and the source diff only when checked', () => {
  const based = { baseDeploymentId: 'dpl_1', baseSnapshot: true };
  const cases: Array<[Parameters<typeof chooseSecurityTier>[0], unknown]> = [
    [
      { trigger: 'deploy', baseDeploymentId: null, baseSnapshot: false },
      { tier: 'full', fullReason: 'first_scan' },
    ],
    [
      { trigger: 'deploy', baseDeploymentId: 'dpl_1', baseSnapshot: false },
      { tier: 'full', fullReason: 'no_usable_base' },
    ],
    [
      { trigger: 'deploy', ...based },
      { tier: 'built_diff', fullReason: null },
    ],
    [
      { trigger: 'gate', ...based },
      { tier: 'built_diff', fullReason: null },
    ],
    [
      { trigger: 'deploy', ...based, sourceDiff: true },
      { tier: 'source_diff', fullReason: null },
    ],
    [
      { trigger: 'rescan', ...based },
      { tier: 'full', fullReason: 'rescan' },
    ],
    [
      { trigger: 'sweep', ...based },
      { tier: 'full', fullReason: 'sweep' },
    ],
    [
      { trigger: 'fallback', ...based, fallbackOf: 'rescan' },
      { tier: 'full', fullReason: 'rescan' },
    ],
  ];
  for (const [input, expected] of cases) {
    expect(chooseSecurityTier(input), JSON.stringify(input)).toMatchObject(expected as object);
  }
});

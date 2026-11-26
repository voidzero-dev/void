import { expect, it } from 'vite-plus/test';
import { securityGitHubCheckCopy } from '../../src/security/github-check.ts';

// I10: only a succeeded scan may say "no urgent findings".
it('never calls an unfinished scan clean on GitHub', () => {
  const copy = (status: string, statusReason: string | null = null) =>
    securityGitHubCheckCopy({
      slug: 'acme-web',
      landingUrl: null,
      status,
      statusReason,
      counts: { critical: 0, high: 0 },
    } as Parameters<typeof securityGitHubCheckCopy>[0]);
  expect(copy('succeeded').title).toBe('No urgent security findings');
  expect(copy('refused').title).toBe('Security scan did not finish (refused)');
  expect(copy('failed', 'bad_output').title).toBe('Security scan did not finish (bad output)');
  expect(copy('failed', 'infrastructure').title).toBe('Security scan did not finish');
  expect(copy('incomplete').summary).toContain('did not cover everything (incomplete)');
});

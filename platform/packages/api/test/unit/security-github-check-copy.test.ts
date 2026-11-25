import { describe, expect, it } from 'vite-plus/test';
import {
  securityGitHubCheckCopy,
  securityPullRequestComment,
} from '../../src/security/github-check.ts';

describe('securityGitHubCheckCopy', () => {
  const base = { slug: 'acme-web', statusReason: null, landingUrl: null } as const;

  it('says the spec copy with counts only', () => {
    expect(
      securityGitHubCheckCopy({ ...base, status: 'succeeded', counts: { critical: 1, high: 1 } }),
    ).toEqual({
      title: '2 urgent security findings (1 critical, 1 high)',
      summary:
        '2 urgent security findings are open in acme-web (1 critical, 1 high). Deploys are not affected. Review: void project security open --project acme-web',
    });
    expect(
      securityGitHubCheckCopy({ ...base, status: 'succeeded', counts: { critical: 0, high: 0 } })
        .title,
    ).toBe('No urgent security findings');
    expect(
      securityGitHubCheckCopy({ ...base, status: 'succeeded', counts: { critical: 0, high: 1 } })
        .title,
    ).toBe('1 urgent security finding (1 high)');
  });

  it('never calls an unfinished scan clean', () => {
    const refused = securityGitHubCheckCopy({
      ...base,
      status: 'refused',
      counts: { critical: 0, high: 0 },
    });
    expect(refused.title).toBe('Security scan did not finish (refused)');
    expect(
      refused.summary.startsWith('The security scan of this commit did not finish (refused).'),
    ).toBe(true);
    expect(
      securityGitHubCheckCopy({
        ...base,
        status: 'failed',
        statusReason: 'bad_output',
        counts: { critical: 0, high: 0 },
      }).title,
    ).toBe('Security scan did not finish (bad output)');
    expect(
      securityGitHubCheckCopy({ ...base, status: 'incomplete', counts: { critical: 0, high: 0 } })
        .summary,
    ).toContain('did not cover everything (incomplete)');
  });

  it('keeps platform-side failure reasons out of the public check', () => {
    for (const statusReason of ['credits', 'infrastructure', null]) {
      const copy = securityGitHubCheckCopy({
        ...base,
        status: 'failed',
        statusReason,
        counts: { critical: 0, high: 0 },
      });
      expect(copy.title).toBe('Security scan did not finish');
      expect(copy.summary.startsWith('The security scan of this commit did not finish.')).toBe(
        true,
      );
    }
    expect(
      securityGitHubCheckCopy({
        ...base,
        status: 'failed',
        statusReason: 'input_missing',
        counts: { critical: 0, high: 0 },
      }).title,
    ).toBe('Security scan did not finish (input missing)');
  });

  it('puts the landing link in the summary and the PR comment', () => {
    const url = 'https://api.example.test/security/projects/acme-web';
    expect(
      securityGitHubCheckCopy({
        ...base,
        landingUrl: url,
        status: 'succeeded',
        counts: { critical: 1, high: 0 },
      }).summary.endsWith(`\n\n${url}`),
    ).toBe(true);
    const comment = securityPullRequestComment({
      projectId: 'proj_1',
      slug: 'acme-web',
      counts: { critical: 1, high: 0 },
      landingUrl: url,
    });
    expect(comment.startsWith('<!-- void-security-audit:proj_1 -->')).toBe(true);
    expect(comment).toContain('1 urgent security finding is open in acme-web (1 critical)');
    expect(comment).toContain(url);
  });
});

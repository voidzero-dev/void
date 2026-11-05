import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../src/log', () => ({
  voidLog: vi.fn(),
  voidWarn: vi.fn(),
  voidError: vi.fn(),
}));

import { lintDuplicateSources } from '../../src/cli/headers.ts';
import type { DevRedirectRule } from '../../src/cli/types.ts';
import { voidWarn } from '../../src/log.ts';

const warnMock = vi.mocked(voidWarn);

function rule(
  source: string,
  origin: string,
  overrides: Partial<DevRedirectRule> = {},
): DevRedirectRule {
  return {
    source,
    destination: '/placeholder',
    status: 200,
    origin,
    ...overrides,
  };
}

describe('lintDuplicateSources', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it('emits no warning when all sources are unique', () => {
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:1'),
      rule('/api/*', 'void.config.ts#routing.rewrites'),
      rule('/blog/*', 'void.config.ts#routing.redirects', { status: 302 }),
    ];

    lintDuplicateSources(rules, 'redirects');

    expect(warnMock).not.toHaveBeenCalled();
  });

  it('emits no warning for an empty or undefined list', () => {
    lintDuplicateSources(undefined, 'x');
    lintDuplicateSources([], 'x');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('emits a single aggregated warning naming the duplicate source and every origin', () => {
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:12'),
      rule('/api/*', 'void.config.ts#routing.redirects', { status: 302 }),
      rule('/docs/*', 'void.config.ts#routing.rewrites'),
    ];

    lintDuplicateSources(rules, 'redirects/rewrites (pre-asset)');

    expect(warnMock).toHaveBeenCalledOnce();
    const msg = warnMock.mock.calls[0][0];
    expect(msg).toContain('redirects/rewrites (pre-asset)');
    expect(msg).toContain('/docs/*');
    expect(msg).toContain('_redirects:12');
    expect(msg).toContain('void.config.ts#routing.rewrites');
    // The non-duplicated /api/* source must not appear
    expect(msg).not.toContain('/api/*');
  });

  it('aggregates multiple duplicate sources into one message', () => {
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:12'),
      rule('/docs/*', 'void.config.ts#routing.rewrites'),
      rule('/api/*', 'void.config.ts#routing.rewrites'),
      rule('/api/*', 'void.config.ts#routing.rewrites'),
      rule('/blog/*', '_redirects:20'),
    ];

    lintDuplicateSources(rules, 'redirects/rewrites (pre-asset)');

    expect(warnMock).toHaveBeenCalledOnce();
    const msg = warnMock.mock.calls[0][0];
    expect(msg).toContain('/docs/*');
    expect(msg).toContain('/api/*');
    expect(msg).not.toContain('/blog/*');
  });

  it('falls back to <unknown> when a rule is missing an origin', () => {
    const rules: Array<DevRedirectRule> = [
      rule('/docs/*', '_redirects:12'),
      { source: '/docs/*', destination: '/en/docs/:splat', status: 200, force: true },
    ];

    lintDuplicateSources(rules, 'redirects/rewrites (pre-asset)');

    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock.mock.calls[0][0]).toContain('<unknown>');
  });
});

import { describe, it, expect } from 'vite-plus/test';
import { isSignupAllowed } from '../../src/signup-allowlist.ts';
import type { AllowlistEntry } from '../../src/signup-allowlist.ts';

describe('isSignupAllowed', () => {
  it('blocks all signups when entries list is empty', () => {
    expect(isSignupAllowed('github', 'octocat', null, [])).toBe(false);
  });

  it('matches github username (case-insensitive)', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'github', pattern: 'Octocat' }];
    expect(isSignupAllowed('github', 'octocat', null, entries)).toBe(true);
  });

  it('rejects unmatched github username', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'github', pattern: 'octocat' }];
    expect(isSignupAllowed('github', 'someone-else', null, entries)).toBe(false);
  });

  it('does not match github entry against google provider', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'github', pattern: 'octocat' }];
    expect(isSignupAllowed('google', 'octocat', 'octocat@gmail.com', entries)).toBe(false);
  });

  it('matches exact email (case-insensitive)', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'email', pattern: 'Alice@Example.com' }];
    expect(isSignupAllowed('google', 'alice', 'alice@example.com', entries)).toBe(true);
  });

  it('matches wildcard domain pattern', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'email', pattern: '*@voidzero.dev' }];
    expect(isSignupAllowed('google', 'alice', 'alice@voidzero.dev', entries)).toBe(true);
  });

  it('rejects email not matching wildcard domain', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'email', pattern: '*@voidzero.dev' }];
    expect(isSignupAllowed('google', 'alice', 'alice@gmail.com', entries)).toBe(false);
  });

  it('rejects google signup with null email', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'email', pattern: '*@voidzero.dev' }];
    expect(isSignupAllowed('google', 'alice', null, entries)).toBe(false);
  });

  it('github user can also match via email entries if they have an email', () => {
    const entries: Array<AllowlistEntry> = [{ type: 'email', pattern: '*@voidzero.dev' }];
    expect(isSignupAllowed('github', 'alice', 'alice@voidzero.dev', entries)).toBe(true);
  });

  it('matches when any entry matches (github username OR email)', () => {
    const entries: Array<AllowlistEntry> = [
      { type: 'github', pattern: 'octocat' },
      { type: 'email', pattern: '*@voidzero.dev' },
    ];
    expect(isSignupAllowed('github', 'octocat', null, entries)).toBe(true);
    expect(isSignupAllowed('google', 'alice', 'alice@voidzero.dev', entries)).toBe(true);
    expect(isSignupAllowed('google', 'bob', 'bob@gmail.com', entries)).toBe(false);
  });
});
